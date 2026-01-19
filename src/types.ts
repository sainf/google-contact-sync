export type SyncOptions = {
  init: boolean;
  rlimSeconds?: number;
  debug: boolean;
  authTimeoutSeconds: number;
  authMode: "local" | "manual";
  apiTimeoutSeconds: number;
  openBrowser: boolean;
  verbose: boolean;
  file: boolean;
};

export type RestoreOptions = {
  verbose: boolean;
};

export type Logger = {
  log: (...args: any[]) => void;
  v: (...args: any[]) => void;
  d?: (...args: any[]) => void;
};
