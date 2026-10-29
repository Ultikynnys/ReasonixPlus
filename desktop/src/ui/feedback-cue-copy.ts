/** Shared copy for the four feedback cues: one table pairs each id with its label and hint
 *  keys, so a new cue cannot be added to the tables in one place and forgotten in another. */

import type { TKey } from "../i18n";
import type { FeedbackCueId } from "../protocol";

export const FEEDBACK_CUES: { id: FeedbackCueId; label: TKey; hint: TKey }[] = [
  {
    id: "inputRequired",
    label: "settings.feedbackCueInputRequired",
    hint: "settings.feedbackCueInputRequiredHint",
  },
  {
    id: "taskComplete",
    label: "settings.feedbackCueTaskComplete",
    hint: "settings.feedbackCueTaskCompleteHint",
  },
  {
    id: "planComplete",
    label: "settings.feedbackCuePlanComplete",
    hint: "settings.feedbackCuePlanCompleteHint",
  },
  {
    id: "guardTriggered",
    label: "settings.feedbackCueGuardTriggered",
    hint: "settings.feedbackCueGuardTriggeredHint",
  },
];
