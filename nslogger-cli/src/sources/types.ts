export interface LogEntry {
  id?: number;
  source: string;
  session_id: string;
  seq: number;
  timestamp: number; // Unix ms
  level: number;     // 0=noise 1=debug 2=info 3=warn 4=error
  tag: string | null;
  thread_id: string;
  message: string;
  filename: string | null;
  line_number: number | null;
  function_name: string | null;
  raw: string | null;
}

export interface SessionInfo {
  session_id: string;
  source: string;
  client_name: string | null;
  client_version: string | null;
  os_name: string | null;
  os_version: string | null;
  device_model: string | null;
  started_at: number;
  ended_at: number | null;
  parse_error: string | null;
}

export type LogSinkFn = (session: SessionInfo, entries: LogEntry[]) => void;

export interface LogSource {
  readonly name: string;
  start(sink: LogSinkFn): Promise<void>;
  stop(): Promise<void>;
}
