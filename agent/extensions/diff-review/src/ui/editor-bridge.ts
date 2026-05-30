// Bridge input shortcuts into the diff-review footer.
// Not for overlay rendering.

import {
	type Component,
	type EditorComponent,
	type Focusable,
	Key,
	matchesKey,
} from "@earendil-works/pi-tui";
import { isToggleKey } from "../platform/keys.ts";

function isFocusableComponent(
	component: Component,
): component is Component & Focusable {
	return "focused" in component;
}

// Wraps the active editor so the toggle key is caught even while the editor has
// focus. Every other call is delegated to the wrapped editor unchanged. This
// mirrors the session-footer-switcher extension's editor-wrapping approach.
export class EditorShortcutBridge implements EditorComponent, Focusable {
	constructor(
		private readonly base: EditorComponent,
		private readonly onToggle: () => void,
		private readonly focusReviewFooter: () => boolean,
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
	setAutocompleteProvider(
		provider: Parameters<
			NonNullable<EditorComponent["setAutocompleteProvider"]>
		>[0],
	): void {
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
		if (isToggleKey(data)) {
			this.onToggle();
			return;
		}
		if (
			matchesKey(data, Key.down) &&
			(this.base.getExpandedText?.() ?? this.base.getText()).trim().length ===
				0 &&
			this.focusReviewFooter()
		) {
			return;
		}
		(this.base as { handleInput?: (data: string) => void }).handleInput?.(data);
	}
}
