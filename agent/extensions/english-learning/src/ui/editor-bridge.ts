import {
	Key,
	matchesKey,
	type AutocompleteProvider,
	type Component,
	type EditorComponent,
	type Focusable,
} from "@earendil-works/pi-tui";
import { shouldSkipInputRewrite } from "../core/text-utils.ts";
import { isTranslateToggleKey, isTranslateToggleKeyPress } from "../platform/keys.ts";

function isFocusableComponent(component: Component): component is Component & Focusable {
	return "focused" in component;
}

export class EnglishEditorBridge implements EditorComponent, Focusable {
	constructor(
		private readonly base: EditorComponent,
		private readonly handlers: {
			onOptimize: (editor: EditorComponent) => void;
			onTranslateToggle: () => void;
		},
	) {}

	get focused(): boolean {
		return isFocusableComponent(this.base) ? this.base.focused : false;
	}
	set focused(value: boolean) {
		if (isFocusableComponent(this.base)) this.base.focused = value;
	}

	get borderColor() {
		return this.base.borderColor;
	}
	set borderColor(value) {
		this.base.borderColor = value;
	}

	get onSubmit() {
		return this.base.onSubmit;
	}
	set onSubmit(value) {
		this.base.onSubmit = value;
	}

	get onChange() {
		return this.base.onChange;
	}
	set onChange(value) {
		this.base.onChange = value;
	}

	get actionHandlers() {
		return (this.base as { actionHandlers?: Map<string, () => void> })
			.actionHandlers;
	}

	get onEscape() {
		return (this.base as { onEscape?: () => void }).onEscape;
	}
	set onEscape(value) {
		(this.base as { onEscape?: () => void }).onEscape = value;
	}

	get onCtrlD() {
		return (this.base as { onCtrlD?: () => void }).onCtrlD;
	}
	set onCtrlD(value) {
		(this.base as { onCtrlD?: () => void }).onCtrlD = value;
	}

	get onPasteImage() {
		return (this.base as { onPasteImage?: () => void }).onPasteImage;
	}
	set onPasteImage(value) {
		(this.base as { onPasteImage?: () => void }).onPasteImage = value;
	}

	get onExtensionShortcut() {
		return (
			this.base as {
				onExtensionShortcut?: (data: string) => boolean | undefined;
			}
		).onExtensionShortcut;
	}
	set onExtensionShortcut(value) {
		(
			this.base as {
				onExtensionShortcut?: (data: string) => boolean | undefined;
			}
		).onExtensionShortcut = value;
	}

	getText(): string {
		return this.base.getText();
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	handleInput(data: string): void {
		if (isTranslateToggleKey(data)) {
			if (isTranslateToggleKeyPress(data)) this.handlers.onTranslateToggle();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			const text = this.getExpandedText();
			if (text.trim() && !shouldSkipInputRewrite(text)) {
				this.handlers.onOptimize(this);
				return;
			}
		}

		this.base.handleInput(data);
	}
}
