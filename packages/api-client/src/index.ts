/** Aervox｜思隅 @aervox/api-client 入口 */
export {
  configureAervoxClient,
  getTransport,
  getSessionId,
  createFetchTransport,
  type AervoxTransport,
  type AervoxClientConfig,
  type TurnCallbacks,
} from './transport';
export { desktopTransport } from './desktop-transport';
export { useAervoxApi, type GoalDto, type ReviewItemDto, type NotificationDto, type DiaryDto } from './useAervoxApi';
export { streamAervoxTurn, type StreamAervoxTurnCallbacks } from './useAervoxTurn';