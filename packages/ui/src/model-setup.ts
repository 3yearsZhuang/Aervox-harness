/** Saved model state exchanged by a host settings panel and its setup view. */
export interface ModelSetupStatus {
  state: 'loading' | 'configured' | 'unconfigured' | 'error';
  busy: boolean;
  modelId?: string;
}
