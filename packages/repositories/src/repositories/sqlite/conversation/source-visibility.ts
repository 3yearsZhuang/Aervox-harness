import { sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { turns, sessions, messages, messageVersions, conversationExecutionPolicies } from "@aervox/schema";
import { conversationDispatchTarget } from "../../../conversation-execution-policy.js";

const sourceTurn = alias(turns, "visibility_turn");
const sourceSession = alias(sessions, "visibility_session");
const sourceVersion = alias(messageVersions, "visibility_version");
const sourceMessage = alias(messages, "visibility_message");
const currentUser = alias(messageVersions, "visibility_current_user");
const latestUser = alias(messageVersions, "visibility_latest_user");
const currentIdentity = alias(messages, "visibility_current_identity");
const validStreamPolicy = sql.join(conversationExecutionPolicies.map(policy => sql`(
  ${sourceTurn.executionPolicy} = ${policy} and ${sourceTurn.dispatchTarget} = ${conversationDispatchTarget(policy)}
)`), sql` or `);

// The original input cannot be replaced by a later edit after physical deletion.
// Extraction redaction also marks the fixed crisis response, so it remains separate
// from online source presence. Aliases let callers correlate an outer Turn safely.
export const disclosableTurn = (turnId: string | SQLWrapper) => sql`exists (
  select 1 from ${turns} as visibility_turn inner join ${sessions} as visibility_session on ${sourceSession.id} = ${sourceTurn.sessionId}
  where ${sourceTurn.id} = ${turnId}
    and ${sourceTurn.executionPolicy} = ${sourceSession.executionPolicy} and (${validStreamPolicy})
    and exists (select 1 from ${messageVersions} as visibility_version
      where ${sourceVersion.turnId} = ${sourceTurn.id}
        and ${sourceVersion.role} = 'user' and ${sourceVersion.version} = 1)
    and not exists (select 1 from ${messageVersions} as visibility_version
      where ${sourceVersion.turnId} = ${sourceTurn.id} and ${sourceVersion.role} = 'user' and ${sourceVersion.version} = 1
        and ${sourceVersion.messageId} is not null and not exists (
          select 1 from ${messages} as visibility_message where ${sourceMessage.id} = ${sourceVersion.messageId}
            and ${sourceMessage.sessionId} = ${sourceTurn.sessionId} and ${sourceMessage.role} = 'user'
            and ${sourceMessage.deletedAt} is null))
    and not exists (select 1 from ${messageVersions} as visibility_version
      where ${sourceVersion.turnId} = ${sourceTurn.id}
        and exists (select 1 from ${messages} as visibility_message
          where ${sourceMessage.deletedAt} is not null and (
            ${sourceMessage.id} = ${sourceVersion.messageId}
            or ${sourceMessage.id} = ${sourceVersion.id}
            or ${sourceMessage.currentVersionId} = ${sourceVersion.id}
          )))
)`;

/** Completed dialogue eligible for model/diary use, independently of user-visible history. */
export const derivableConversationTurn = (turnId: string | SQLWrapper) => sql`(
  ${disclosableTurn(turnId)} and exists (
    select 1 from ${turns} as visibility_turn where ${sourceTurn.id} = ${turnId} and ${sourceTurn.status} = 'Completed'
      and exists (select 1 from ${messageVersions} as visibility_current_user where ${currentUser.turnId} = ${sourceTurn.id}
        and ${currentUser.role} = 'user' and ${currentUser.supersededAt} is null and ${currentUser.isRedacted} = 0
        and ${currentUser.version} = (select max(${latestUser.version}) from ${messageVersions} as visibility_latest_user
          where ${latestUser.turnId} = ${sourceTurn.id} and ${latestUser.role} = 'user' and ${latestUser.supersededAt} is null)
        and (${currentUser.messageId} is null or exists (
          select 1 from ${messages} as visibility_current_identity where ${currentIdentity.id} = ${currentUser.messageId}
            and ${currentIdentity.sessionId} = ${sourceTurn.sessionId} and ${currentIdentity.role} = 'user'
            and ${currentIdentity.deletedAt} is null and ${currentIdentity.currentVersionId} = ${currentUser.id})))
  )
)`;
