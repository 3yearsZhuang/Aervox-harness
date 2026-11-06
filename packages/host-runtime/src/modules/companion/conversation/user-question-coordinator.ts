/** Host delivery wrapper. The shared waiter owns no durable question state. */
import type { AskUserQuestionAnswerItem } from "@aervox/contracts";
import type { IUserQuestionRepository, SqliteConversationRepository, LocalContext } from "@aervox/repositories";
import { UserQuestionWaiter, type QuestionExecutionOwner, type QuestionIdentity } from "@aervox/host-agent/browser";
import { turnStreamHub } from "./stream-hub.js";

export class UserQuestionCoordinator {
  private readonly waiter: UserQuestionWaiter<LocalContext>;
  constructor(private readonly conversationRepo: SqliteConversationRepository, _pendingRepo?: IUserQuestionRepository) {
    this.waiter = new UserQuestionWaiter({
      require: (ctx, input) => conversationRepo.requireUserQuestion(ctx, input),
      getPending: (ctx, turnId) => conversationRepo.getPendingUserQuestion(ctx, turnId),
      getReceipt: (ctx, identity) => conversationRepo.getUserQuestionAnswerReceipt(ctx, identity),
      answer: (ctx, identity, answers) => conversationRepo.answerUserQuestion(ctx, identity, answers),
      cancel: (ctx, input) => conversationRepo.cancelUserQuestion(ctx, input),
    }, { publish: event => turnStreamHub.publishEvent(event.turnId, event) });
  }

  createPort(ctx: LocalContext, owner?: QuestionExecutionOwner) {
    return this.waiter.createPort(ctx, owner ?? (() => undefined));
  }

  async getPending(ctx: LocalContext, turnId: string) {
    return (await this.conversationRepo.getPendingUserQuestion(ctx, turnId)) ?? undefined;
  }

  async submitAnswers(ctx: LocalContext, turnId: string, answers: AskUserQuestionAnswerItem[],
    identity?: Omit<QuestionIdentity, "turnId">) {
    const receipt = await this.waiter.submit(ctx, { turnId, attemptId: identity?.attemptId ?? "",
      invocationId: identity?.invocationId ?? "", step: identity?.step ?? 0 }, answers);
    const { event: _event, ...response } = receipt;
    return response;
  }
}
