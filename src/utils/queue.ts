import EventEmitter from 'mitt'
import { HttpError, RateLimitError } from '../api'
import { sleep } from './utils'

type RequestFn<T> = () => Promise<T>

/** Public shape callers pass to `add()` */
interface RequestObject<T> {
    name: string
    request: RequestFn<T>
}

/** Internal shape with per-item retry counters */
interface InternalRequestObject<T> extends RequestObject<T> {
    retries: number // general error retries
    blockRetries: number // 403 (Cloudflare block) pauses triggered by this item
}

export type RequestStatus = 'processing' | 'retrying' | 'rate_limited'

interface ProgressEvent {
    total: number
    completed: number
    currentName: string
    currentStatus: RequestStatus
    /** Seconds remaining in a rate-limit pause (only set when status === 'rate_limited') */
    rateLimitWaitSecs?: number
}

/** Max retries for generic (non-429) errors before skipping a single request */
const MAX_RETRIES = 5
/**
 * Max times the entire queue can be globally paused for rate limiting before
 * giving up and stopping the queue entirely.
 */
const MAX_GLOBAL_PAUSES = 5
/**
 * Default pause length (ms) applied to the whole queue on a 429.
 * Used when the API does not return a Retry-After header.
 */
const DEFAULT_429_PAUSE_MS = 60_000
/**
 * Pause length (ms) applied to the whole queue on a 403.
 * A 403 burst usually means a Cloudflare block that clears after a cool-down.
 */
const DEFAULT_403_PAUSE_MS = 15_000
/** Max global pauses a single item may trigger via 403 before it is skipped */
const MAX_403_RETRIES_PER_ITEM = 3

export class RequestQueue<T> {
    private eventEmitter = EventEmitter<{
        done: T[]
        progress: ProgressEvent
    } & Record<string, any[]>>()

    private queue: Array<InternalRequestObject<T>> = []
    private results: T[] = []

    private status: 'IDLE' | 'IN_PROGRESS' | 'STOPPED' | 'COMPLETED' = 'IDLE'

    private readonly backoffMultiplier = 2
    private backoff: number

    private total = 0
    private completed = 0

    /**
     * Timestamp (ms since epoch) until which the whole queue is frozen after
     * receiving a 429. While Date.now() < pauseUntil every process() iteration
     * waits out the remainder before making the next request.
     */
    private pauseUntil = 0
    /** How many global rate-limit pauses have been applied so far */
    private globalPauses = 0

    /**
     * Consulted when a single item has exhausted its automatic retries.
     * Return true to grant the item a fresh round of retries (e.g. after
     * asking the user), false to skip it. When absent the item is skipped.
     */
    onItemExhausted?: (name: string, error: unknown) => boolean | Promise<boolean>
    /**
     * Consulted when the whole queue has been paused MAX_GLOBAL_PAUSES times
     * without recovering. Return true to keep waiting and retrying (the pause
     * escalation restarts), false to stop the queue. When absent it stops.
     */
    onPausesExhausted?: (error: unknown) => boolean | Promise<boolean>

    constructor(private minBackoff: number, private maxBackoff: number) {
        this.backoff = minBackoff
    }

    add(requestObject: RequestObject<T>) {
        this.queue.push({ ...requestObject, retries: 0, blockRetries: 0 })
    }

    start() {
        if (this.status === 'IDLE') {
            this.total = this.queue.length
            this.process()
        }
    }

    stop() {
        this.status = 'STOPPED'
        this.eventEmitter.emit('done', this.results)
    }

    clear() {
        this.queue = []
        this.results = []
        this.status = 'IDLE'
        this.backoff = this.minBackoff
        this.pauseUntil = 0
        this.globalPauses = 0
        this.total = 0
        this.completed = 0
    }

    on(event: 'progress', fn: (progress: ProgressEvent) => void): () => void
    on(event: 'done', fn: (result: T[]) => void): () => void
    on(event: string, fn: (...args: any[]) => void): () => void {
        this.eventEmitter.on(event, fn)
        return () => this.eventEmitter.off(event, fn)
    }

    private async process() {
        if (this.status === 'STOPPED' || this.status === 'COMPLETED') {
            return
        }

        if (this.queue.length === 0) {
            this.done()
            return
        }

        // ── Global rate-limit pause ──────────────────────────────────────────
        // If a previous request set pauseUntil, wait for the remainder before
        // making any new request. This freezes the whole queue at once instead
        // of per-item retries, so 100 queued items don't each wait 30s in turn.
        const remaining = this.pauseUntil - Date.now()
        if (remaining > 0) {
            const waitSecs = Math.ceil(remaining / 1000)
            // Broadcast the pause status for every item currently at the front
            this.progress(this.queue[0].name, 'rate_limited', waitSecs)
            await sleep(remaining)
            this.pauseUntil = 0
        }

        this.status = 'IN_PROGRESS'
        const requestObject = this.queue.shift()!
        const { name, request } = requestObject

        let waitMs = this.backoff

        try {
            this.progress(name, 'processing')
            const result = await request()
            this.results.push(result)
            this.completed++
            this.progress(name, 'processing')
            this.backoff = this.minBackoff // reset on success
            requestObject.retries = 0
            // A success means the rate limit / block cleared — restore the full
            // pause budget so a long export isn't aborted by sporadic 429s.
            this.globalPauses = 0
        }
        catch (error) {
            if (error instanceof RateLimitError) {
                this.globalPauses++
                if (this.globalPauses > MAX_GLOBAL_PAUSES) {
                    // Rate limit persists even after several long pauses —
                    // let the caller (user) decide whether to keep waiting.
                    if (this.onPausesExhausted && await this.onPausesExhausted(error)) {
                        this.globalPauses = 1 // keep going — restart the pause escalation
                    }
                    else {
                        console.warn('[Exporter] Queue stopped: API rate limit did not clear after', MAX_GLOBAL_PAUSES, 'pauses')
                        this.stop()
                        return
                    }
                }
                // Freeze the whole queue. Exponentially increase the pause so
                // we back off harder if the first pause wasn't long enough.
                const pauseMs = Math.max(
                    error.retryAfterMs,
                    DEFAULT_429_PAUSE_MS * this.globalPauses,
                )
                this.pauseUntil = Date.now() + pauseMs
                this.progress(name, 'rate_limited', Math.round(pauseMs / 1000))
                console.warn(`[Exporter] Rate limited (429). Pausing queue for ${Math.round(pauseMs / 1000)}s (pause #${this.globalPauses})`)
                // Put this item back — it will be retried after the pause clears
                this.queue.unshift(requestObject)
                waitMs = 0 // the sleep is handled at the top of the next process() call
            }
            else if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
                // The conversation no longer exists (deleted or inaccessible).
                // Retrying can't help — skip immediately without asking the user.
                console.warn(`[Exporter] "${name}" skipped: not found (${error.status})`)
                waitMs = 0 // skip — don't re-queue
            }
            else if (error instanceof HttpError && error.status === 403) {
                // A 403 burst usually means a Cloudflare block that affects every
                // request — freeze the whole queue like a 429, with a shorter pause.
                requestObject.blockRetries++
                if (requestObject.blockRetries > MAX_403_RETRIES_PER_ITEM) {
                    // Still 403 after several pauses — this item is likely just forbidden.
                    if (this.onItemExhausted && await this.onItemExhausted(name, error)) {
                        requestObject.blockRetries = 0
                        this.progress(name, 'retrying')
                        this.queue.unshift(requestObject)
                    }
                    else {
                        console.warn(`[Exporter] "${name}" skipped after ${MAX_403_RETRIES_PER_ITEM} forbidden (403) retries`)
                    }
                    waitMs = 0
                }
                else {
                    this.globalPauses++
                    if (this.globalPauses > MAX_GLOBAL_PAUSES) {
                        if (this.onPausesExhausted && await this.onPausesExhausted(error)) {
                            this.globalPauses = 1 // keep going — restart the pause escalation
                        }
                        else {
                            console.warn('[Exporter] Queue stopped: API kept responding 403 after', MAX_GLOBAL_PAUSES, 'pauses')
                            this.stop()
                            return
                        }
                    }
                    const pauseMs = DEFAULT_403_PAUSE_MS * this.globalPauses
                    this.pauseUntil = Date.now() + pauseMs
                    this.progress(name, 'rate_limited', Math.round(pauseMs / 1000))
                    console.warn(`[Exporter] Forbidden (403). Pausing queue for ${Math.round(pauseMs / 1000)}s (pause #${this.globalPauses})`)
                    // Put this item back — it will be retried after the pause clears
                    this.queue.unshift(requestObject)
                    waitMs = 0 // the sleep is handled at the top of the next process() call
                }
            }
            else {
                console.error(`[Exporter] "${name}" failed:`, error)
                requestObject.retries++
                if (requestObject.retries > MAX_RETRIES) {
                    if (this.onItemExhausted && await this.onItemExhausted(name, error)) {
                        requestObject.retries = 0
                        this.backoff = this.minBackoff
                        this.progress(name, 'retrying')
                        this.queue.unshift(requestObject)
                        waitMs = this.backoff
                    }
                    else {
                        console.warn(`[Exporter] "${name}" skipped after ${MAX_RETRIES} retries`)
                        waitMs = 0 // skip — don't re-queue
                    }
                }
                else {
                    this.backoff = Math.min(this.backoff * this.backoffMultiplier, this.maxBackoff)
                    waitMs = this.backoff
                    this.progress(name, 'retrying')
                    this.queue.unshift(requestObject)
                }
            }
        }

        await sleep(waitMs)
        this.process()
    }

    private progress(name: string, status: RequestStatus, rateLimitWaitSecs?: number) {
        this.eventEmitter.emit('progress', {
            total: this.total,
            completed: this.completed,
            currentName: name,
            currentStatus: status,
            rateLimitWaitSecs,
        })
    }

    private done() {
        this.status = 'COMPLETED'
        this.eventEmitter.emit('done', this.results)
    }
}
