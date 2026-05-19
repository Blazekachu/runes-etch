import type { VanityConfig, VanityProgress } from '@/types';

export interface GrindParams {
  txTemplate: Uint8Array;
  nonceOffset: number;
  nonceLength: number;
  config: VanityConfig;
  onProgress: (progress: VanityProgress) => void;
  onFound: (nonce: Uint8Array, txid: string) => void;
}

export class VanityGrinder {
  private worker: Worker | null = null;

  start(params: GrindParams): void {
    this.stop();

    this.worker = new Worker(
      new URL('./worker.ts', import.meta.url),
      { type: 'module' },
    );

    const { txTemplate, nonceOffset, nonceLength, config, onProgress, onFound } = params;

    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data;

      if (data.type === 'progress') {
        const progress: VanityProgress = {
          attempts: data.attempts,
          speed: data.speed,
          bestMatch: data.bestMatch,
          found: false,
          nonce: null,
        };
        onProgress(progress);
      } else if (data.type === 'found') {
        const progress: VanityProgress = {
          attempts: data.attempts,
          speed: 0,
          bestMatch: data.txid,
          found: true,
          nonce: data.nonce,
        };
        onProgress(progress);
        onFound(data.nonce as Uint8Array, data.txid as string);
        this.stop();
      }
    };

    this.worker.onerror = (err: ErrorEvent) => {
      console.error('[VanityGrinder] Worker error:', err.message);
    };

    this.worker.postMessage({
      type: 'start',
      txTemplate,
      nonceOffset,
      nonceLength,
      prefix: config.prefix,
      suffix: config.suffix,
      batchSize: 10_000,
    });
  }

  stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  isRunning(): boolean {
    return this.worker !== null;
  }

  static estimateDifficulty(
    prefix: string,
    suffix: string,
  ): { avgAttempts: number; description: string } {
    const totalChars = prefix.length + suffix.length;
    const avgAttempts = Math.pow(16, totalChars);

    let description: string;
    if (avgAttempts <= 1_000) {
      description = 'Instant (< 1 second)';
    } else if (avgAttempts <= 100_000) {
      description = 'Fast (a few seconds)';
    } else if (avgAttempts <= 10_000_000) {
      description = 'Moderate (seconds to a minute)';
    } else if (avgAttempts <= 1_000_000_000) {
      description = 'Slow (minutes)';
    } else {
      description = 'Very slow (could take hours)';
    }

    return { avgAttempts, description };
  }
}
