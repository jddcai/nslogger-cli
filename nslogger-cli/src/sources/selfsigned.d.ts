declare module 'selfsigned' {
  export interface SelfsignedResult {
    private: string;
    public: string;
    cert: string;
    fingerprint: string;
  }
  export function generate(
    attrs?: Array<{ name: string; value: string }>,
    opts?: { days?: number; keySize?: number; algorithm?: string },
  ): SelfsignedResult;
  const _default: { generate: typeof generate };
  export default _default;
}
