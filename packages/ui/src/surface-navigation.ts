/** A trusted host supplies the available surfaces; visual consumers do not own URLs or IDs. */
export interface SurfaceNavigation {
  readonly currentId: string;
  readonly options: readonly {readonly value: string; readonly label: string}[];
  select(id: string): void;
  openDefault(): void;
}
