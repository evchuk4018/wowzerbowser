import "server-only";

import { databaseOwnerId, query } from "../database/database";

type ComparisonExecutionRow = {
  comparison_id: string;
  trial_id: string;
  display_a_variant: "a" | "b";
  option_a_response_id: string | null;
  option_b_response_id: string | null;
  selected_label: "a" | "b" | null;
};

export async function findAbTestComparisonForTurn(
  ownerId: string,
  trialId: string,
  conversationId: string,
  turnId: string,
): Promise<ComparisonExecutionRow | null> {
  const [row] = await query<ComparisonExecutionRow>(
    `select comparison_id,trial_id,display_a_variant,option_a_response_id,option_b_response_id,selected_label
       from ab_test_comparisons
      where owner_id=$1 and trial_id=$2 and conversation_id=$3 and turn_id=$4`,
    [databaseOwnerId(ownerId), trialId, conversationId, turnId],
  );
  return row ?? null;
}

export async function selectAbTestVersion(input: {
  ownerId: string;
  conversationId: string;
  turnId: string;
  responseId: string;
}): Promise<string> {
  const owner = databaseOwnerId(input.ownerId);
  const [version] = await query<{ version_id: string; version_index: number }>(
    `select version_id,version_index from chat_messages
      where owner_id=$1 and conversation_id=$2 and turn_id=$3 and message_id=$4 and role='assistant'`,
    [owner, input.conversationId, input.turnId, input.responseId],
  );
  if (!version) throw new Error("The selected A/B response is unavailable.");
  await query(
    `update chat_turns set active_version=$1,updated_at=$2
      where owner_id=$3 and conversation_id=$4 and turn_id=$5`,
    [version.version_index, new Date().toISOString(), owner, input.conversationId, input.turnId],
  );
  return version.version_id;
}
