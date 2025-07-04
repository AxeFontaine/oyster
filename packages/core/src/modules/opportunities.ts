import dayjs from 'dayjs';
import dedent from 'dedent';
import { sql } from 'kysely';
import { jsonBuildObject } from 'kysely/helpers/postgres';
import { match } from 'ts-pattern';
import { z } from 'zod';

import { db } from '@oyster/db';
import { ISO8601Date, nullableField } from '@oyster/types';
import { id } from '@oyster/utils';

import { getChatCompletion } from '@/infrastructure/ai';
import { job, registerWorker } from '@/infrastructure/bull';
import {
  type GetBullJobData,
  OpportunityBullJob,
} from '@/infrastructure/bull.types';
import { track } from '@/infrastructure/mixpanel';
import { getPageContent } from '@/infrastructure/puppeteer';
import { redis } from '@/infrastructure/redis';
import { reportException } from '@/infrastructure/sentry';
import { saveCompanyIfNecessary } from '@/modules/employment/use-cases/save-company-if-necessary';
import { STUDENT_PROFILE_URL } from '@/shared/env';
import { ACCENT_COLORS, type AccentColor } from '@/shared/utils/color';
import { fail, type Result, success } from '@/shared/utils/core';

// Use Case(s)

const EXPIRED_PHRASES = [
  '404',
  'closed',
  'does not exist',
  "doesn't exist",
  'expired',
  'filled',
  'no longer accepting',
  'no longer available',
  'no longer exists',
  'no longer open',
  'not accepting',
  'not available',
  'not be found',
  'not currently accepting',
  'not found',
  'not open',
  'oops',
  'removed',
  'sorry',
];

// "Add Opportunity"

export const AddOpportunityInput = z.object({
  link: z
    .string()
    .trim()
    .startsWith('http', 'URL must start with "http".')
    .url(),

  postedBy: z.string().trim().min(1),
});

type AddOpportunityInput = z.infer<typeof AddOpportunityInput>;

type AddOpportunityResult = Result<{ id: string }>;

/**
 * Adds a new opportunity from the Member Profile, given a link.
 *
 * This function handles checking for duplicates, creating the initial record,
 * and attempting to enrich it by parsing the webpage content. While the initial
 * creation succeeds with default values, parsing the content is best-effort -
 * if it fails, the basic opportunity record is still retained. The reason we
 * don't fail is that we allow the user to edit the opportunity themselves
 * immediately after it's created.
 *
 * @param input - Object containing the opportunity URL and poster.
 * @returns Success result with the opportunity ID.
 */
export async function addOpportunity({
  link,
  postedBy,
}: AddOpportunityInput): Promise<AddOpportunityResult> {
  const existingOpportunity = await db
    .selectFrom('opportunities')
    .where('link', 'ilike', link)
    .executeTakeFirst();

  if (existingOpportunity) {
    return fail({
      code: 409,
      error: 'Someone already posted this link.',
    });
  }

  // We create a blank opportunity because we want to allow the user to edit
  // the opportunity themselves regardless if the AI succeeds or not.
  const opportunity = await db
    .insertInto('opportunities')
    .values({
      createdAt: new Date(),
      description: 'N/A',
      expiresAt: dayjs().add(1, 'month').toDate(),
      id: id(),
      link,
      postedBy,
      title: 'Opportunity',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  let websiteContent = '';

  try {
    websiteContent = await getPageContent(link);
  } catch (e) {
    reportException(e);
  }

  // If we can't get the content, we'll just exit gracefully/early.
  if (!websiteContent) {
    return success(opportunity);
  }

  const hasExpired = EXPIRED_PHRASES.some((phrase) => {
    return websiteContent.toLowerCase().includes(phrase);
  });

  // If the opportunity is actually expired, we'll delete the blank record
  // and return a failure message.
  if (hasExpired) {
    await db
      .deleteFrom('opportunities')
      .where('id', '=', opportunity.id)
      .executeTakeFirstOrThrow();

    return fail({
      code: 404,
      error: 'It looks like the opportunity you are trying to add has closed.',
    });
  }

  await refineOpportunity({
    content: websiteContent,
    opportunityId: opportunity.id,
  });

  return success(opportunity);
}

// "Bookmark Opportunity"

type BookmarkOpportunityInput = {
  memberId: string;
  opportunityId: string;
};

/**
 * Bookmarks an opportunity for a member.
 *
 * If the member already bookmarked the opportunity, this function will remove
 * the bookmark. Otherwise, it will create a new bookmark and give points to
 * the member who _posted_ the opportunity.
 *
 * @param input - The opportunity to bookmark and the member bookmarking it.
 * @returns Result indicating the success or failure of the operation.
 */
export async function bookmarkOpportunity({
  memberId,
  opportunityId,
}: BookmarkOpportunityInput): Promise<Result> {
  const action = await db.transaction().execute(async (trx) => {
    const existingBookmark = await trx
      .deleteFrom('opportunityBookmarks')
      .where('opportunityId', '=', opportunityId)
      .where('studentId', '=', memberId)
      .executeTakeFirst();

    if (existingBookmark.numDeletedRows) {
      return 'deleted';
    }

    await trx
      .insertInto('opportunityBookmarks')
      .values({ opportunityId, studentId: memberId })
      .execute();

    return 'created';
  });

  if (action === 'created') {
    const opportunity = await db
      .selectFrom('opportunities')
      .leftJoin('companies', 'companies.id', 'opportunities.companyId')
      .select(['companies.name as companyName', 'postedBy'])
      .where('opportunities.id', '=', opportunityId)
      .executeTakeFirst();

    if (opportunity && opportunity.companyName) {
      track({
        event: 'Opportunity Bookmarked',
        properties: { Company: opportunity.companyName },
        user: memberId,
      });
    }

    if (opportunity && opportunity.postedBy) {
      job('gamification.activity.completed', {
        opportunityBookmarkedBy: memberId,
        opportunityId,
        studentId: opportunity.postedBy,
        type: 'get_opportunity_bookmark',
      });
    }
  }

  return success({});
}

// "Check for Deleted Opportunity (in Slack)"

type CheckForDeletedOpportunityInput = Pick<
  GetBullJobData<'slack.message.change'>,
  'channelId' | 'deletedAt' | 'id'
>;

/**
 * Checks for a soft-deleted opportunity. This is the case when somebody
 * posts a message in an opportunity channel, someone else replies to it, and
 * then the original message is soft-deleted (but still exists because there
 * are replies).
 */
export async function checkForDeletedOpportunity({
  channelId,
  deletedAt,
  id: messageId,
}: CheckForDeletedOpportunityInput): Promise<void> {
  if (!deletedAt) {
    return;
  }

  const isOpportunityChannel = await redis.sismember(
    'slack:opportunity_channels',
    channelId
  );

  if (!isOpportunityChannel) {
    return;
  }

  const opportunity = await db
    .selectFrom('opportunities')
    .select('id')
    .where('slackChannelId', '=', channelId)
    .where('slackMessageId', '=', messageId)
    .executeTakeFirst();

  if (opportunity) {
    await deleteOpportunity({ opportunityId: opportunity.id });
  }
}

/**
 * This function uses puppeteer to scrape the opportunity's website and
 * determine whether or not the opportunity has closed or not. If it has,
 * the opportunity will be marked as "expired" and thus will no longer appear
 * in the opportunities board.
 *
 * Returns `true` if the opportunity has expired, `false` otherwise.
 *
 * @param input - The opportunity to check for expiration.
 */
async function checkForExpiredOpportunity(
  opportunityId: string,
  force: boolean = false
): Promise<Result<boolean>> {
  const opportunity = await db
    .selectFrom('opportunities')
    .select(['expiresAt', 'link'])
    .where('id', '=', opportunityId)
    .where('expiresAt', '>', new Date())
    .$if(!force, (qb) => {
      return qb.where((eb) => {
        const threeHoursAgo = dayjs().subtract(3, 'hour').toDate();

        return eb.or([
          eb('lastExpirationCheck', 'is', null),
          eb('lastExpirationCheck', '<=', threeHoursAgo),
        ]);
      });
    })
    .executeTakeFirst();

  // If the opportunity isn't found or there is no link, then we'll just exit
  // gracefully.
  if (!opportunity || !opportunity.link) {
    return success(false);
  }

  await db
    .updateTable('opportunities')
    .set({ lastExpirationCheck: new Date() })
    .where('id', '=', opportunityId)
    .executeTakeFirst();

  let content = '';

  try {
    content = await getPageContent(opportunity.link);
  } catch (e) {
    reportException(e);

    return fail({
      code: 500,
      error: 'Failed to get page content.',
    });
  }

  const hasExpired = EXPIRED_PHRASES.some((phrase) => {
    return content.toLowerCase().includes(phrase);
  });

  if (hasExpired) {
    await db
      .updateTable('opportunities')
      .set({ expiresAt: new Date() })
      .where('id', '=', opportunityId)
      .executeTakeFirst();
  }

  return success(hasExpired);
}

type CheckForExpiredOpportunitiesInput = {
  limit: number;
};

/**
 * Checks for expired opportunities and marks them as expired. This can be
 * triggered via a Bull job. This is limited to 100 opportunities at a time
 * to prevent overwhelming our server with too many puppeteer instances.
 *
 * @returns The number of opportunities marked as expired.
 */
async function checkForExpiredOpportunities({
  limit,
}: CheckForExpiredOpportunitiesInput): Promise<Result> {
  const opportunities = await db
    .selectFrom('opportunities')
    .select('id')
    .where('expiresAt', '>', new Date())
    .where('lastExpirationCheck', 'is', null)
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .execute();

  for (const opportunity of opportunities) {
    job('opportunity.check_expired', {
      force: true,
      opportunityId: opportunity.id,
    });
  }

  return success({});
}

type CreateOpportunityFromSlackInput = {
  sendNotification?: boolean;
  slackChannelId: string;
  slackMessageId: string;
};

/**
 * Creates an opportunity from a Slack message.
 *
 * If the Slack message does not contain a link to an opportunity, this function
 * will return early with a success result.
 *
 * Otherwise, we'll pass the Slack message into AI to extract the opportunity's
 * company, title, and description. Then, we'll try to find the most relevant
 * company in our database. Then, we save the opportunity in our database and
 * notify the original poster that we've added it to our opportunities board.
 *
 * @param input - Input data for creating an opportunity.
 * @returns Result indicating the success or failure of the operation.
 */
async function createOpportunityFromSlack({
  sendNotification = true,
  slackChannelId,
  slackMessageId,
}: CreateOpportunityFromSlackInput): Promise<Result> {
  const slackMessage = await db
    .selectFrom('slackMessages')
    .select(['studentId', 'text', 'userId as slackUserId'])
    .where('channelId', '=', slackChannelId)
    .where('id', '=', slackMessageId)
    .executeTakeFirst();

  // This might be the case if someone posts something in the opportunity
  // channel but then quickly deletes it right after.
  if (!slackMessage || !slackMessage.text) {
    return fail({
      code: 404,
      error: 'Could not create opportunity b/c Slack message was not found.',
    });
  }

  const link = getFirstLinkInMessage(slackMessage.text);

  // We're only interested in messages that contain a link to an opportunity...
  // so we'll gracefully bail if there isn't one.
  if (!link) {
    return success({});
  }

  const existingOpportunity = await db
    .selectFrom('opportunities')
    .where('link', 'ilike', link)
    .executeTakeFirst();

  // If someone already posted this exact opportunity, we'll just exit early.
  if (existingOpportunity) {
    return success({});
  }

  const isProtectedURL =
    link.includes('docs.google.com') || link.includes('linkedin.com');

  let websiteContent = '';

  if (!isProtectedURL) {
    try {
      websiteContent = await getPageContent(link);
    } catch (e) {
      reportException(e);
    }
  }

  const opportunity = await db
    .insertInto('opportunities')
    .values({
      createdAt: new Date(),
      description: 'N/A',
      expiresAt: dayjs().add(1, 'month').toDate(),
      id: id(),
      link,
      postedBy: slackMessage.studentId,
      slackChannelId,
      slackMessageId,
      title: 'Opportunity',
    })
    .onConflict((oc) => {
      return oc.columns(['slackChannelId', 'slackMessageId']).doUpdateSet({
        // This does nothing, just here to ensure the `returning` clause
        // works w/ the upsert command.
        description: 'N/A',
      });
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  // If the link is NOT a protected URL, we'll scrape the website content
  // using puppeteer, create a new "empty" opportunity, and then refine it with
  // AI using that website content.
  if (websiteContent) {
    return refineOpportunity({
      content: websiteContent.slice(0, 10_000),
      opportunityId: opportunity.id,
      slackChannelId,
      slackUserId: slackMessage.slackUserId,
    });
  }

  if (sendNotification) {
    sendOpportunityRefinementNotification({
      opportunityId: opportunity.id,
      slackChannelId,
      slackUserId: slackMessage.slackUserId,
    });
  }

  return success(opportunity);
}

// "Create Opportunity Tag"

export const CreateOpportunityTagInput = z.object({
  // @ts-expect-error - not sure why b/c AccentColor extends `string`!
  color: z.enum(ACCENT_COLORS),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
});

type CreateOpportunityTagInput = z.infer<typeof CreateOpportunityTagInput>;

/**
 * Creates a new opportunity tag. This doesn't associate the tag with any
 * opportunities, it just creates it top-level.
 *
 * If a tag with the same name (case insensitive) already exists, this function
 * will return a failure.
 *
 * @param input - The tag to create.
 * @returns Result indicating the success or failure of the operation.
 */
export async function createOpportunityTag(
  input: CreateOpportunityTagInput
): Promise<Result> {
  const existingTag = await db
    .selectFrom('opportunityTags')
    .where('name', 'ilike', input.name)
    .executeTakeFirst();

  if (existingTag) {
    return fail({
      code: 409,
      error: 'A tag with that name already exists.',
    });
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('opportunityTags')
      .values({
        color: input.color,
        createdAt: new Date(),
        id: input.id,
        name: input.name,
      })
      .execute();
  });

  return success({});
}

// "Delete Opportunity"

type DeleteOpportunityInput = {
  memberId?: string;
  opportunityId: string;
};

/**
 * Deletes an opportunity from the database, only if the given member has
 * permission to do so. The database will cascade delete any associated records
 * (ie: tags, bookmarks, etc).
 *
 * @param input - The opportunity to delete and the member deleting it.
 * @returns Result indicating the success or failure of the operation.
 */
export async function deleteOpportunity({
  memberId,
  opportunityId,
}: DeleteOpportunityInput): Promise<Result> {
  if (memberId) {
    const hasPermission = await hasOpportunityWritePermission({
      memberId,
      opportunityId,
    });

    if (!hasPermission) {
      return fail({
        code: 403,
        error: 'You do not have permission to delete this opportunity.',
      });
    }
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('opportunities')
      .where('opportunities.id', '=', opportunityId)
      .execute();
  });

  return success({ id: opportunityId });
}

// "Edit Opportunity"

export const EditOpportunityInput = z.object({
  companyId: nullableField(z.string().trim().min(1).nullable()),
  companyName: nullableField(z.string().trim().min(1).nullable()),
  description: z.string().trim().min(1).max(500),
  expiresAt: ISO8601Date,
  tags: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.split(',')),
  title: z.string().trim().min(1),
});

type EditOpportunityInput = z.infer<typeof EditOpportunityInput>;

/**
 * Edits an opportunity.
 *
 * @param opportunityId - The opportunity to edit.
 * @param input - The updated values for the opportunity.
 * @returns Result indicating the success or failure of the operation.
 */
export async function editOpportunity(
  opportunityId: string,
  input: EditOpportunityInput
): Promise<Result> {
  const result = await db.transaction().execute(async (trx) => {
    const companyId = input.companyId
      ? input.companyId
      : await saveCompanyIfNecessary(trx, input.companyName);

    const result = await trx
      .updateTable('opportunities')
      .set({
        companyId,
        description: input.description,
        expiresAt: input.expiresAt,
        title: input.title,
      })
      .where('id', '=', opportunityId)
      .executeTakeFirst();

    await trx
      .deleteFrom('opportunityTagAssociations')
      .where('opportunityId', '=', opportunityId)
      .where('tagId', 'not in', input.tags)
      .execute();

    await trx
      .insertInto('opportunityTagAssociations')
      .values(
        input.tags.map((tagId) => {
          return {
            opportunityId,
            tagId,
          };
        })
      )
      .onConflict((oc) => oc.doNothing())
      .execute();

    return result;
  });

  return success(result);
}

// "Refine Opportunity"

const REFINE_OPPORTUNITY_SYSTEM_PROMPT = dedent`
  You are a helpful assistant that extracts structured data from a website's
  (likely a job posting) text content.
`;

// Need to help AI out by telling it the current year...Claude 3.5 doesn't
// seem to know the current date.
const CURRENT_YEAR = new Date().getFullYear();

const REFINE_OPPORTUNITY_PROMPT = dedent`
  Your job is to analyze the given webpage and extract the following information
  and format it as JSON:

  1. "company": The name of the company offering the opportunity.
  2. "title": The title of the opportunity, max 75 characters. Do not include
     the company name in the title.
  3. "description": A brief description of the opportunity, max 400 characters.
     Extract the most relevant information including what the opportunity is,
     who it's for, when, potential compensation and any other relevant details
     to someone open to the opportunity.
  4. "expiresAt": The date that the opportunity is no longer relevant, in
     'YYYY-MM-DD' format. This should almost always be a date in the FUTURE
     (the current year is ${CURRENT_YEAR}). If the opportunity seemingly never
     "closes", set this to null.
  5. "tags": A list of tags that fit this opportunity, maximum 5 tags and
     minimum 1 tag. This is the MOST IMPORTANT FIELD. We have a list of existing
     tags in our database that are available to associate with this opportunity.
     If there are no relevant tags, DO NOT create new tags and instead return
     null for this field. Some rules for tags:
      - There shouldn't be more than one of the following tags: AI/ML,
        Cybersecurity, Data Science, DevOps, PM, QA, Quant, SWE or UI/UX Design.
      - There shouldn't be more than one of the following tags: Co-op,
        Early Career, Fellowship, or Internship.
      - "Early Career" should only be used for full-time roles targeted at
        recent graduates.
      - Only use "Fall", "Spring" or "Winter" tags if it is an internship/co-op
        opportunity that is in those seasons.
      - Use the "Event" tag if the opportunity is related to an event,
        conference, or short-term (< 1 week) program.

  Here's the webpage you need to analyze:

  <website_content>
    $WEBSITE_CONTENT
  </website_content>

  Here are the existing tags in our database that you can choose from:

  <tags>
    $TAGS
  </tags>

  Follow these guidelines:
  - If you cannot confidently infer a field, set it to null.
  - If the page is not found, expired, or otherwise not a valid opportunity,
    set all fields to null.
  - Double check that your output is based on the website content. Don't make
    up information that you cannot confidently infer from the website content.

  Your output should be a single JSON object containing these fields. Do not
  provide any explanation or text outside of the JSON object. Ensure your JSON
  is properly formatted and valid.

  <output>
    {
      "company": "string | null",
      "description": "string | null",
      "expiresAt": "string | null",
      "tags": "string[] | null",
      "title": "string | null"
    }
  </output>
`;

const RefineOpportunityResponse = z.object({
  company: z.string().trim().min(1).nullable(),
  description: z.string().trim().min(1).max(500).nullable(),
  expiresAt: z.string().nullable(),
  tags: z.array(z.string().trim().min(1)).min(1).nullable(),
  title: z.string().trim().min(1).max(100).nullable(),
});

type RefineOpportunityResponse = z.infer<typeof RefineOpportunityResponse>;

export const RefineOpportunityInput = z.object({
  content: z.string().trim().min(1).max(10_000),
  opportunityId: z.string().trim().min(1),
});

type RefineOpportunityInput = z.infer<typeof RefineOpportunityInput> &
  Partial<{
    slackChannelId: string;
    slackUserId: string;
  }>;

/**
 * Refines an opportunity by extracting structured data from the given
 * webpage content.
 *
 * The most important piece is extracting the tags w/ AI. We try our best to
 * use existing tags in our database, but if there are no relevant tags, we'll
 * create a new one.
 *
 * @param input - The content of the webpage to extract data from.
 * @returns Result indicating the success or failure of the operation.
 */
export async function refineOpportunity(
  input: RefineOpportunityInput
): Promise<Result> {
  const tags = await db
    .selectFrom('opportunityTags')
    .select(['id', 'name'])
    .orderBy('name', 'asc')
    .execute();

  const prompt = REFINE_OPPORTUNITY_PROMPT
    //
    .replace('$WEBSITE_CONTENT', input.content)
    .replace('$TAGS', tags.map((tag) => tag.name).join('\n'));

  const completionResult = await getChatCompletion({
    maxTokens: 500,
    messages: [{ role: 'user', content: prompt }],
    system: [{ type: 'text', text: REFINE_OPPORTUNITY_SYSTEM_PROMPT }],
    temperature: 0,
  });

  if (!completionResult.ok) {
    return completionResult;
  }

  let json: JSON;

  try {
    json = JSON.parse(completionResult.data);
  } catch (e) {
    console.debug(
      'Failed to parse JSON from AI response.',
      completionResult.data
    );

    return fail({
      code: 400,
      error: 'Failed to parse JSON from AI response.',
    });
  }

  let data: RefineOpportunityResponse;

  try {
    data = RefineOpportunityResponse.parse(json);
  } catch (error) {
    console.error(error);

    return fail({
      code: 400,
      error: 'Failed to validate JSON from AI response.',
    });
  }

  // If the AI didn't return a title, then we don't want to finish the process
  // because there was no opportunity to refine. We exit gracefully.
  if (!data.title || !data.description) {
    if (input.slackChannelId && input.slackUserId) {
      sendOpportunityRefinementNotification({
        opportunityId: input.opportunityId,
        slackChannelId: input.slackChannelId,
        slackUserId: input.slackUserId,
      });
    }

    return success({});
  }

  const opportunity = await db.transaction().execute(async (trx) => {
    const companyId = data.company
      ? await saveCompanyIfNecessary(trx, data.company)
      : null;

    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : undefined;

    const opportunity = await trx
      .updateTable('opportunities')
      .set({
        ...(data.description && { description: data.description }),
        ...(data.title && { title: data.title }),
        companyId,
        expiresAt,
      })
      .where('id', '=', input.opportunityId)
      .returning(['id', 'refinedAt', 'slackChannelId', 'slackMessageId'])
      .executeTakeFirstOrThrow();

    // We only want to set this once so that we can evaluate the time it takes
    // from creation to refinement of an opportunity.
    await trx
      .updateTable('opportunities')
      .set({ refinedAt: new Date() })
      .where('id', '=', input.opportunityId)
      .where('refinedAt', 'is', null)
      .executeTakeFirst();

    if (!data.tags) {
      return opportunity;
    }

    const matchedTags = await trx
      .selectFrom('opportunityTags')
      .select('id')
      .where('name', 'in', data.tags)
      .execute();

    await trx
      .insertInto('opportunityTagAssociations')
      .values(
        matchedTags.map((tag) => {
          return {
            opportunityId: opportunity.id,
            tagId: tag.id,
          };
        })
      )
      .onConflict((oc) => oc.doNothing())
      .execute();

    return opportunity;
  });

  // If this is the first time the opportunity has been refined, we want to send
  // a notification to the channel.
  if (
    opportunity.slackChannelId &&
    opportunity.slackMessageId &&
    !opportunity.refinedAt
  ) {
    const message = `I added this to our <${STUDENT_PROFILE_URL}/opportunities/${opportunity.id}|opportunities board>! 📌`;

    job('notification.slack.send', {
      channel: opportunity.slackChannelId,
      message,
      threadId: opportunity.slackMessageId,
      workspace: 'regular',
    });
  }

  return success(opportunity);
}

type ReportOpportunityInput = {
  opportunityId: string;
  reason: string;
  reporterId: string;
};

/**
 * Reports an opportunity if it is no longer working or is otherwise
 * useless.
 *
 * If an opportunity receives 2 or more reports, or if it's reported by an
 * admin, it will be automatically removed (expired).
 *
 * @param opportunityId - ID of the opportunity to report
 * @param reason - Reason for reporting the opportunity.
 * @param reporterId - ID of the member reporting the opportunity.
 * @returns Object indicating whether the opportunity was removed
 */

export async function reportOpportunity({
  opportunityId,
  reason,
  reporterId,
}: ReportOpportunityInput) {
  await db
    .insertInto('opportunityReports')
    .values({ opportunityId, reason, reporterId })
    .onConflict((oc) => oc.doNothing())
    .execute();

  const [{ reports }, admin] = await Promise.all([
    db
      .selectFrom('opportunityReports')
      .select(({ fn }) => fn.countAll<number>().as('reports'))
      .where('opportunityId', '=', opportunityId)
      .executeTakeFirstOrThrow(),

    db
      .selectFrom('admins')
      .where('memberId', '=', reporterId)
      .executeTakeFirst(),
  ]);

  const shouldRemove = reports >= 2 || !!admin;

  if (shouldRemove) {
    await db
      .updateTable('opportunities')
      .set({ expiresAt: new Date() })
      .where('id', '=', opportunityId)
      .executeTakeFirstOrThrow();
  }

  return success({ removed: shouldRemove });
}

// Helpers

/**
 * Extracts the first URL found in the Slack message.
 *
 * @param message - Slack message to extract the URL from.
 * @returns First URL found in the message or `null` if it doesn't exist.
 */
function getFirstLinkInMessage(message: string): string | undefined {
  return message.match(/<(https?:\/\/[^\s|>]+)(?:\|[^>]+)?>/)?.[1];
}

type SendOpportunityRefinementNotificationInput = {
  opportunityId: string;
  slackChannelId: string;
  slackUserId: string;
};

/**
 * Sends a notification to the original poster of an opportunity to refine
 * the opportunity using AI w/ the website content. This is likely because
 * our automated system was unable to extract the necessary information from
 * the website content.
 *
 * @param input - The opportunity to refine.
 */
function sendOpportunityRefinementNotification({
  opportunityId,
  slackChannelId,
  slackUserId,
}: SendOpportunityRefinementNotificationInput) {
  const message =
    `Thanks for sharing an opportunity in <#${slackChannelId}>! To add it to our <${STUDENT_PROFILE_URL}/opportunities|opportunities board>, please paste the opportunity's website content <${STUDENT_PROFILE_URL}/opportunities/${opportunityId}/refine|*HERE*>.\n\n` +
    'Appreciate you! 🙂';

  job('notification.slack.send', {
    channel: slackUserId,
    message,
    workspace: 'regular',
  });
}

// Queries

// "Get Opportunity"

export async function getOpportunity(opportunityId: string) {
  const opportunity = await db
    .selectFrom('opportunities')
    .leftJoin('companies', 'companies.id', 'opportunities.companyId')
    .select([
      'companies.name as companyName',
      'opportunities.description',
      'opportunities.title',
    ])
    .where('opportunities.id', '=', opportunityId)
    .executeTakeFirst();

  return opportunity;
}

// "Get Opportunity Details"

type GetOpportunityDetailsInput = {
  memberId: string;
  opportunityId: string;
};

export async function getOpportunityDetails({
  memberId,
  opportunityId,
}: GetOpportunityDetailsInput) {
  const opportunity = await db
    .selectFrom('opportunities')
    .leftJoin('companies', 'companies.id', 'opportunities.companyId')
    .leftJoin('students', 'students.id', 'opportunities.postedBy')
    .leftJoin('slackMessages', (join) => {
      return join
        .onRef('slackMessages.channelId', '=', 'opportunities.slackChannelId')
        .onRef('slackMessages.id', '=', 'opportunities.slackMessageId');
    })
    .select([
      'companies.id as companyId',
      'companies.imageUrl as companyLogo',
      'companies.name as companyName',
      'opportunities.createdAt',
      'opportunities.description',
      'opportunities.expiresAt',
      'opportunities.id',
      'opportunities.link',
      'opportunities.title',
      'slackMessages.channelId as slackMessageChannelId',
      'slackMessages.createdAt as slackMessagePostedAt',
      'slackMessages.id as slackMessageId',
      'slackMessages.text as slackMessageText',
      'students.firstName as posterFirstName',
      'students.lastName as posterLastName',
      'students.profilePicture as posterProfilePicture',

      (eb) => {
        return eb
          .selectFrom('opportunityBookmarks')
          .whereRef('opportunityId', '=', 'opportunities.id')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .as('bookmarks');
      },

      (eb) => {
        return eb
          .exists(() => {
            return eb
              .selectFrom('opportunityBookmarks')
              .whereRef('opportunityId', '=', 'opportunities.id')
              .where('opportunityBookmarks.studentId', '=', memberId);
          })
          .as('bookmarked');
      },

      (eb) => {
        return eb
          .or([
            eb('opportunities.postedBy', '=', memberId),
            eb.exists(() => {
              return eb
                .selectFrom('admins')
                .where('admins.memberId', '=', memberId)
                .where('admins.deletedAt', 'is', null);
            }),
          ])
          .as('hasWritePermission');
      },

      (eb) => {
        return eb
          .selectFrom('opportunityTagAssociations')
          .leftJoin(
            'opportunityTags',
            'opportunityTags.id',
            'opportunityTagAssociations.tagId'
          )
          .whereRef('opportunityId', '=', 'opportunities.id')
          .select(({ fn, ref }) => {
            const object = jsonBuildObject({
              color: ref('opportunityTags.color'),
              id: ref('opportunityTags.id'),
              name: ref('opportunityTags.name'),
            });

            type TagObject = {
              color: AccentColor;
              id: string;
              name: string;
            };

            return fn
              .jsonAgg(sql`${object} order by ${ref('name')} asc`)
              .$castTo<TagObject[]>()
              .as('tags');
          })
          .as('tags');
      },
    ])
    .where('opportunities.id', '=', opportunityId)
    .executeTakeFirst();

  return opportunity;
}

// "Has Edit Permission"

type HasEditPermissionInput = {
  memberId: string;
  opportunityId: string;
};

/**
 * Checks if the given member has write (ie: create/edit/delete) permission for
 * the opportunity. Returns `true` if the member is the creator of the
 * opportunity or if the member is an admin.
 *
 * @param input - Member ID and opportunity ID.
 * @returns Whether the member has write permission for the opportunity.
 */
export async function hasOpportunityWritePermission({
  memberId,
  opportunityId,
}: HasEditPermissionInput): Promise<boolean> {
  const opportunity = await db
    .selectFrom('opportunities')
    .where('opportunities.id', '=', opportunityId)
    .where((eb) => {
      return eb.or([
        eb('opportunities.postedBy', '=', memberId),
        eb.exists(() => {
          return eb
            .selectFrom('admins')
            .where('admins.memberId', '=', memberId)
            .where('admins.deletedAt', 'is', null);
        }),
      ]);
    })
    .executeTakeFirst();

  return !!opportunity;
}

// "List Opportunity Tags"

export async function listOpportunityTags() {
  return db
    .selectFrom('opportunityTags')
    .select(['color', 'id', 'name'])
    .orderBy('name', 'asc')
    .execute();
}

// Worker

export const opportunityWorker = registerWorker(
  'opportunity',
  OpportunityBullJob,
  async (job) => {
    const result = await match(job)
      .with({ name: 'opportunity.check_expired' }, async ({ data }) => {
        return checkForExpiredOpportunity(data.opportunityId, data.force);
      })
      .with({ name: 'opportunity.check_expired.all' }, async ({ data }) => {
        return checkForExpiredOpportunities(data);
      })
      .with({ name: 'opportunity.create' }, async ({ data }) => {
        return createOpportunityFromSlack(data);
      })
      .exhaustive();

    if (!result.ok) {
      throw new Error(result.error);
    }

    return result.data;
  }
);
