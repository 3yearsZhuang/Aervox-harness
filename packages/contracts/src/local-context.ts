/** Local OS user context shared by ports; not a persistence or tenancy boundary. */
export interface LocalContext {
  readonly workspaceId: string;
  readonly subjectUserId: string;
  readonly actorId?: string;
}
