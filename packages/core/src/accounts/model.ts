export interface Account {
  readonly key: string;
  readonly id: string;
  readonly settingsKey: string;
  readonly objectKey: string | null;
  readonly written: number;
  readonly settingsEpoch: number;
}
