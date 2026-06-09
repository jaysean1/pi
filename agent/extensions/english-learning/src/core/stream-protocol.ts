export interface TranslationParserCallbacks {
	onSegmentStart?: (id: number) => void;
	onDelta: (id: number, delta: string) => void;
	onSegmentEnd?: (id: number) => void;
}

const OPEN_TAG_RE = /<t\s+id=["']?(\d+)["']?\s*>/i;
const CLOSE_TAG = "</t>";

export class SegmentTranslationParser {
	private buffer = "";
	private currentId: number | undefined;
	private emittedAnyTag = false;

	constructor(private readonly callbacks: TranslationParserCallbacks) {}

	get sawTags(): boolean {
		return this.emittedAnyTag;
	}

	push(delta: string): void {
		if (!delta) return;
		this.buffer += delta;
		this.drain(false);
	}

	finish(): void {
		this.drain(true);
		if (this.currentId !== undefined && this.buffer) {
			this.callbacks.onDelta(this.currentId, this.buffer);
			this.buffer = "";
			this.callbacks.onSegmentEnd?.(this.currentId);
			this.currentId = undefined;
		}
	}

	private drain(final: boolean): void {
		for (;;) {
			if (this.currentId !== undefined) {
				const closeIndex = this.buffer.toLowerCase().indexOf(CLOSE_TAG);
				if (closeIndex >= 0) {
					const text = this.buffer.slice(0, closeIndex);
					if (text) this.callbacks.onDelta(this.currentId, text);
					this.buffer = this.buffer.slice(closeIndex + CLOSE_TAG.length);
					this.callbacks.onSegmentEnd?.(this.currentId);
					this.currentId = undefined;
					continue;
				}

				if (final) return;
				const safeLength = Math.max(0, this.buffer.length - CLOSE_TAG.length);
				if (safeLength > 0) {
					const text = this.buffer.slice(0, safeLength);
					this.callbacks.onDelta(this.currentId, text);
					this.buffer = this.buffer.slice(safeLength);
				}
				return;
			}

			const open = this.buffer.match(OPEN_TAG_RE);
			if (!open || open.index === undefined) {
				if (final) this.buffer = "";
				else if (this.buffer.length > 80) this.buffer = this.buffer.slice(-80);
				return;
			}

			const id = Number.parseInt(open[1]!, 10);
			this.buffer = this.buffer.slice(open.index + open[0].length);
			if (!Number.isFinite(id)) continue;
			this.currentId = id;
			this.emittedAnyTag = true;
			this.callbacks.onSegmentStart?.(id);
		}
	}
}
