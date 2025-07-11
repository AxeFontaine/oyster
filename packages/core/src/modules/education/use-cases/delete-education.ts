import { db } from '@oyster/db';

import { checkMostRecentEducation } from './check-most-recent-education';
import { type Education } from '../education.types';

type DeleteEducationInput = Pick<Education, 'id' | 'studentId'>;

export async function deleteEducation({ id, studentId }: DeleteEducationInput) {
  await db
    .updateTable('educations')
    .set({ deletedAt: new Date() })
    .where('educations.id', '=', id)
    .where('educations.studentId', '=', studentId)
    .execute();

  checkMostRecentEducation(studentId);
}
