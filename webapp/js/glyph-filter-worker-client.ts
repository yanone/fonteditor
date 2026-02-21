import { Logger } from './logger';

const console = new Logger('GlyphFilterWorkerClient');

export interface GlyphFilterWorkerResult {
    results: any[];
    groups: Record<string, any>;
    status: string;
    contextPatch?: Record<string, any>;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
}

interface RunBuiltinFilterRequest {
    type: 'runBuiltinFilter';
    id: number;
    keyword: string;
    fontJson: string;
    timeoutMs: number;
}

interface RunUserFilterRequest {
    type: 'runUserFilter';
    id: number;
    code: string;
    fontJson: string;
    timeoutMs: number;
}

interface WorkerSuccessResponse {
    id: number;
    ok: true;
    results?: any[];
    groups?: Record<string, any>;
    status?: string;
    installed?: string[];
    contextPatch?: Record<string, any>;
    applied?: boolean;
    version?: number;
}

interface WorkerErrorResponse {
    id: number;
    ok: false;
    error: string;
}

type WorkerRequestPayload =
    | {
          type: 'runBuiltinFilter';
          keyword: string;
          fontJson: string;
          timeoutMs: number;
      }
    | {
          type: 'runUserFilter';
          code: string;
          fontJson: string;
          timeoutMs: number;
      }
    | {
          type: 'installPackages';
          packages: string[];
      }
    | {
          type: 'syncSharedContext';
          context: Record<string, any>;
          version: number;
      };

export class GlyphFilterWorkerClient {
    private worker: Worker | null = null;
    private readyPromise: Promise<void> | null = null;
    private requestId = 1;
    private pending = new Map<number, PendingRequest>();

    private async ensureWorker(): Promise<void> {
        if (this.readyPromise) {
            return this.readyPromise;
        }

        this.readyPromise = new Promise((resolve, reject) => {
            const worker = new Worker('js/glyph-filter-worker.js', {
                type: 'module'
            });

            this.worker = worker;

            const onMessage = (event: MessageEvent) => {
                const data = event.data;

                if (data?.type === 'ready') {
                    resolve();
                    return;
                }

                if (data?.type === 'error' && data?.during === 'init') {
                    reject(
                        new Error(data.error || 'Worker initialization failed')
                    );
                    return;
                }

                this.handleWorkerMessage(event);
            };

            worker.addEventListener('message', onMessage);
            worker.onerror = (error) => {
                reject(new Error(error.message || 'Glyph filter worker error'));
            };

            worker.postMessage({ type: 'init' });
        });

        try {
            await this.readyPromise;
        } catch (error) {
            console.error('Worker failed to initialize:', error);
            this.readyPromise = null;
            if (this.worker) {
                this.worker.terminate();
                this.worker = null;
            }
            throw error;
        }
    }

    private handleWorkerMessage(event: MessageEvent): void {
        const data = event.data as WorkerSuccessResponse | WorkerErrorResponse;
        if (!data || typeof data.id !== 'number') {
            return;
        }

        const pending = this.pending.get(data.id);
        if (!pending) {
            return;
        }

        this.pending.delete(data.id);

        if ((data as WorkerSuccessResponse).ok) {
            const success = data as WorkerSuccessResponse;
            if (Array.isArray(success.results) || success.status) {
                pending.resolve({
                    results: success.results || [],
                    groups: success.groups || {},
                    status: success.status || 'ok',
                    contextPatch: success.contextPatch
                });
            } else {
                pending.resolve({ installed: success.installed || [] });
            }
            return;
        }

        const failure = data as WorkerErrorResponse;
        pending.reject(
            new Error(failure.error || 'Glyph filter worker failed')
        );
    }

    private async sendRequest(
        payload: WorkerRequestPayload
    ): Promise<GlyphFilterWorkerResult> {
        await this.ensureWorker();

        const id = this.requestId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });

            try {
                this.worker!.postMessage({ ...payload, id });
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    async runBuiltinFilter(
        keyword: string,
        fontJson: string,
        timeoutMs: number
    ): Promise<GlyphFilterWorkerResult> {
        return this.sendRequest({
            type: 'runBuiltinFilter',
            keyword,
            fontJson,
            timeoutMs
        });
    }

    async runUserFilter(
        code: string,
        fontJson: string,
        timeoutMs: number
    ): Promise<GlyphFilterWorkerResult> {
        return this.sendRequest({
            type: 'runUserFilter',
            code,
            fontJson,
            timeoutMs
        });
    }

    async installPackages(packages: string[]): Promise<void> {
        if (!Array.isArray(packages) || packages.length === 0) {
            return;
        }

        await this.sendRequest({
            type: 'installPackages',
            packages
        });
    }

    async syncSharedContext(
        context: Record<string, any>,
        version: number
    ): Promise<void> {
        await this.sendRequest({
            type: 'syncSharedContext',
            context,
            version
        });
    }
}
