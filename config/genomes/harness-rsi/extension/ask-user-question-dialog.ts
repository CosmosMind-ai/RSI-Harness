/**
 * Ported verbatim from Pi's own `AskUserQuestion` dialog
 * (packages/coding-agent/src/modes/interactive/components/ask-user-question-dialog.ts).
 *
 * That component is a core built-in in the upstream fork but is not in the
 * released package this Genome runs against, so the Genome carries its own copy
 * rather than depending on a fork. The only changes are the imports and taking
 * the theme through the constructor instead of a module singleton.
 */
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";

export interface AskUserQuestionDialogOption {
	label: string;
	description?: string;
}

export interface AskUserQuestionDialogQuestion {
	header?: string;
	question: string;
	options?: AskUserQuestionDialogOption[];
	allowMultiple?: boolean;
	placeholder?: string;
}

export interface AskUserQuestionDialogAnswer {
	header?: string;
	question: string;
	answer: string;
	selections?: string[];
	customAnswer?: string;
}

export type AskUserQuestionDialogResult =
	| { type: "answers"; answers: AskUserQuestionDialogAnswer[] }
	| { type: "chat" };

interface QuestionState {
	selectedIndex: number;
	checkedOptions: Set<number>;
	inputValue: string;
}

/** Raw terminal sequences (real input) plus canonical names (tests / direct calls). */
const TAB_KEYS = new Set(["\t", "tab"]);
const SHIFT_TAB_KEYS = new Set(["\x1b[Z", "shift+tab"]);
const LEFT_KEYS = new Set(["\x1b[D", "left"]);
const RIGHT_KEYS = new Set(["\x1b[C", "right"]);

export class AskUserQuestionDialog extends Container implements Focusable {
	private readonly questions: AskUserQuestionDialogQuestion[];
	private readonly theme: Theme;
	private readonly done: (result: AskUserQuestionDialogResult | undefined) => void;
	private readonly tui: TUI | undefined;
	private readonly navText: Text;
	private readonly titleText: Text;
	private readonly listContainer: Container;
	private readonly footerText: Text;
	private readonly input: Input;
	private readonly answers = new Map<number, AskUserQuestionDialogAnswer>();
	private readonly questionStates = new Map<number, QuestionState>();
	private questionIndex = 0;
	private selectedIndex = 0;
	private checkedOptions = new Set<number>();
	private _focused = false;

	/** Index of the submit review tab (questions.length), or -1 when hidden. */
	private get submitTabIndex(): number {
		return this.hideSubmitTab ? -1 : this.questions.length;
	}

	/** Single single-select question submits immediately — no submit review tab. */
	private get hideSubmitTab(): boolean {
		return this.questions.length === 1 && !this.allowsMultiple(this.questions[0]!);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	constructor(
		questions: AskUserQuestionDialogQuestion[],
		theme: Theme,
		done: (result: AskUserQuestionDialogResult | undefined) => void,
		tui?: TUI,
	) {
		super();
		this.questions = questions;
		this.theme = theme;
		this.done = done;
		this.tui = tui;
		this.navText = new Text("", 0, 0);
		this.titleText = new Text("", 0, 0);
		this.listContainer = new Container();
		this.footerText = new Text("", 0, 0);
		this.input = new Input();

		this.addChild(this.navText);
		this.addChild(new Spacer(1));
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.footerText);

		this.renderCurrentTab();
	}

	private get currentQuestion(): AskUserQuestionDialogQuestion {
		return this.questions[this.questionIndex]!;
	}

	private get isSubmitView(): boolean {
		return this.questionIndex === this.questions.length;
	}

	private get currentOptions(): AskUserQuestionDialogOption[] {
		return this.currentQuestion.options ?? [];
	}

	private hasOptions(question: AskUserQuestionDialogQuestion = this.currentQuestion): boolean {
		return (question.options?.length ?? 0) > 0;
	}

	private allowsMultiple(question: AskUserQuestionDialogQuestion = this.currentQuestion): boolean {
		return question.allowMultiple === true;
	}

	private get customRowIndex(): number {
		return this.currentOptions.length;
	}

	private get chatRowIndex(): number {
		return this.customRowIndex + 1;
	}

	private get chatRowNumber(): number {
		return this.chatRowIndex + 1;
	}

	private isCustomRowSelected(): boolean {
		return this.hasOptions() && this.selectedIndex === this.customRowIndex;
	}

	private isChatRowSelected(): boolean {
		return this.selectedIndex === this.chatRowIndex;
	}

	private syncInputFocus(): void {
		this.input.focused = this._focused && !this.isSubmitView && (!this.hasOptions() || this.isCustomRowSelected());
	}

	private finish(): void {
		const answers = Array.from(this.answers.entries())
			.sort(([left], [right]) => left - right)
			.map(([, answer]) => answer);
		this.done({ type: "answers", answers });
	}

	private cancel(): void {
		this.done(undefined);
	}

	private chatAboutIt(): void {
		this.done({ type: "chat" });
	}

	private saveCurrentState(): void {
		this.questionStates.set(this.questionIndex, {
			selectedIndex: this.selectedIndex,
			checkedOptions: new Set(this.checkedOptions),
			inputValue: this.input.getValue(),
		});
	}

	private restoreState(index: number): void {
		this.questionIndex = index;
		const state = this.questionStates.get(index);
		this.selectedIndex = state?.selectedIndex ?? 0;
		this.checkedOptions = state ? new Set(state.checkedOptions) : new Set();
		this.input.setValue(state?.inputValue ?? "");
	}

	private nextTab(): void {
		const tabCount = this.submitTabIndex >= 0 ? this.questions.length + 1 : this.questions.length;
		this.saveCurrentState();
		this.restoreState((this.questionIndex + 1) % tabCount);
		this.syncInputFocus();
		this.renderCurrentTab();
	}

	private prevTab(): void {
		const tabCount = this.submitTabIndex >= 0 ? this.questions.length + 1 : this.questions.length;
		this.saveCurrentState();
		this.restoreState((this.questionIndex - 1 + tabCount) % tabCount);
		this.syncInputFocus();
		this.renderCurrentTab();
	}

	private commitCurrentAnswer(): void {
		const question = this.currentQuestion;
		const customAnswer = this.input.getValue().trim();

		if (!this.hasOptions(question)) {
			this.commitAnswer({ answer: customAnswer, customAnswer: customAnswer || undefined });
			return;
		}

		if (this.allowsMultiple(question)) {
			const selections = Array.from(this.checkedOptions)
				.sort((left, right) => left - right)
				.map((index) => this.currentOptions[index]?.label)
				.filter((option): option is string => option !== undefined);
			if (selections.length === 0 && !customAnswer && this.selectedIndex < this.currentOptions.length) {
				const selected = this.currentOptions[this.selectedIndex]?.label;
				if (selected) {
					selections.push(selected);
				}
			}
			const answer = [...selections, ...(customAnswer ? [customAnswer] : [])].join(", ");
			this.commitAnswer({ answer, selections, customAnswer: customAnswer || undefined });
			return;
		}

		if (this.isCustomRowSelected() && customAnswer) {
			this.commitAnswer({ answer: customAnswer, customAnswer });
			return;
		}

		const selected =
			this.currentOptions[Math.min(this.selectedIndex, this.currentOptions.length - 1)]?.label ?? customAnswer;
		this.commitAnswer({
			answer: selected,
			selections: selected && this.currentOptions.some((opt) => opt.label === selected) ? [selected] : undefined,
			customAnswer: selected === customAnswer && customAnswer ? customAnswer : undefined,
		});
	}

	private commitAnswer(answer: { answer: string; selections?: string[]; customAnswer?: string }): void {
		const question = this.currentQuestion;
		this.answers.set(this.questionIndex, {
			header: question.header,
			question: question.question,
			answer: answer.answer,
			selections: answer.selections,
			customAnswer: answer.customAnswer,
		});

		// Single single-select question: selecting submits immediately.
		if (this.hideSubmitTab) {
			this.finish();
			return;
		}
		this.nextTab();
	}

	private renderCurrentTab(): void {
		this.syncInputFocus();
		this.navText.setText(this.renderNavBar());
		this.listContainer.clear();

		if (this.isSubmitView) {
			this.titleText.setText(this.theme.bold(this.theme.fg("text", "Ready to submit your answers?")));
			this.renderSubmitView();
			this.footerText.setText(
				this.theme.fg("dim", `${rawKeyHint("Enter", "to submit")}  ${rawKeyHint("Esc", "to cancel")}`),
			);
			return;
		}

		const question = this.currentQuestion;
		this.titleText.setText(this.theme.bold(this.theme.fg("text", question.question)));

		if (this.hasOptions(question)) {
			this.renderOptionsQuestion(question);
			this.footerText.setText(this.renderOptionsFooter(question));
			return;
		}

		this.renderInputOnlyQuestion(question.placeholder);
		this.footerText.setText(
			this.theme.fg("dim", `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`),
		);
	}

	/** Chip-style tab bar, one chip per question plus a Submit tab, current one highlighted. */
	private renderNavBar(): string {
		const parts: string[] = [];
		for (const [index, question] of this.questions.entries()) {
			const name = question.header?.trim() || `Question ${index + 1}`;
			if (index === this.questionIndex) {
				parts.push(this.theme.bg("selectedBg", ` ${name} `));
			} else {
				parts.push(this.theme.fg("dim", `□ ${name}`));
			}
		}
		if (this.submitTabIndex >= 0) {
			parts.push(this.isSubmitView ? this.theme.bg("selectedBg", " ✓ Submit ") : this.theme.fg("dim", `✓ Submit`));
		}
		if (this.questions.length > 1) {
			parts.push(this.theme.fg("dim", `· ${this.answers.size}/${this.questions.length} answered`));
		}
		return parts.join("  ");
	}

	private renderOptionsQuestion(question: AskUserQuestionDialogQuestion): void {
		for (const [index, option] of this.currentOptions.entries()) {
			this.listContainer.addChild(
				new Text(this.renderOptionLine(index, option, this.allowsMultiple(question)), 0, 0),
			);
			if (option.description?.trim()) {
				this.listContainer.addChild(new Text(this.renderDescriptionLine(option.description.trim()), 0, 0));
			}
		}

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(this.renderCustomAnswerLabel(), 0, 0));
		const hint = question.placeholder?.trim();
		if (hint) {
			this.listContainer.addChild(new Text(this.renderDescriptionLine(hint), 0, 0));
		}
		this.listContainer.addChild(this.input);

		this.listContainer.addChild(new Spacer(1));
		this.listContainer.addChild(new Text(this.renderDivider(), 0, 0));
		this.listContainer.addChild(new Text(this.renderChatRow(), 0, 0));
	}

	private renderSubmitView(): void {
		const allAnswered = this.answers.size === this.questions.length;
		if (!allAnswered) {
			this.listContainer.addChild(new Text(this.theme.fg("warning", `⚠ You have not answered all questions`), 0, 0));
			this.listContainer.addChild(new Spacer(1));
		}

		for (const [index, question] of this.questions.entries()) {
			const answer = this.answers.get(index);
			const number = this.theme.fg("dim", `${index + 1}.`);
			this.listContainer.addChild(new Text(`${number} ${this.theme.fg("text", question.question)}`, 0, 0));
			this.listContainer.addChild(
				new Text(`     ${answer ? this.theme.fg("success", answer.answer) : this.theme.fg("muted", "(Not answered)")}`, 0, 0),
			);
		}
	}

	/** Numbered option row: "› 1. label" with the focus arrow on the selected row. */
	private renderOptionLine(index: number, option: AskUserQuestionDialogOption, multi: boolean): string {
		const focused = index === this.selectedIndex;
		const checked = this.checkedOptions.has(index);
		const arrow = focused ? this.theme.fg("accent", "› ") : "  ";
		const marker = multi
			? checked
				? this.theme.fg("success", "[x] ")
				: this.theme.fg(focused ? "accent" : "dim", "[ ] ")
			: "";
		const number = this.theme.fg(focused ? "accent" : "dim", `${index + 1}.`);
		const label = focused ? this.theme.fg("accent", option.label) : this.theme.fg(checked ? "success" : "text", option.label);
		return `${arrow}${marker}${number} ${label}`;
	}

	/** Description sub-line, indented to align with the option label. */
	private renderDescriptionLine(description: string): string {
		const prefixWidth = this.allowsMultiple() ? "› [x] 1. ".length : "› 1. ".length;
		return `${" ".repeat(prefixWidth)}${this.theme.fg("dim", description)}`;
	}

	/**
	 * The last row is always a free-text answer, so no option list can trap the
	 * user inside the choices the model happened to think of.
	 */
	private renderCustomAnswerLabel(): string {
		const focused = this.isCustomRowSelected();
		const arrow = focused ? this.theme.fg("accent", "› ") : "  ";
		const number = this.theme.fg("dim", `${this.customRowIndex + 1}.`);
		const label = focused ? this.theme.fg("accent", "Other") : this.theme.fg("muted", "Other");
		return `${arrow}${number} ${label}`;
	}

	private renderDivider(): string {
		const columns = this.tui?.terminal.columns ?? 80;
		return this.theme.fg("dim", "─".repeat(Math.max(20, columns - 4)));
	}

	private renderChatRow(): string {
		const focused = this.isChatRowSelected();
		const arrow = focused ? this.theme.fg("accent", "› ") : "  ";
		const number = this.theme.fg("dim", `${this.chatRowNumber}.`);
		const label = focused ? this.theme.fg("accent", "Chat about this") : this.theme.fg("muted", "Chat about this");
		return `${arrow}${number} ${label}`;
	}

	private renderInputOnlyQuestion(placeholderText?: string): void {
		this.listContainer.addChild(this.input);
		if (placeholderText?.trim()) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", placeholderText.trim()), 0, 0));
		}
	}

	private renderOptionsFooter(question: AskUserQuestionDialogQuestion): string {
		const parts = [
			rawKeyHint("Enter", "to select"),
			...((this.allowsMultiple(question) ? [rawKeyHint("space", "to mark")] : []) as string[]),
			...((this.questions.length > 1 ? [rawKeyHint("Tab/←→", "to navigate")] : []) as string[]),
			rawKeyHint("Esc", "to cancel"),
		];
		return this.theme.fg("dim", parts.join(this.theme.fg("dim", " · ")));
	}

	private shouldRouteToCustomInput(keyData: string): boolean {
		const kb = getKeybindings();
		if (!this.hasOptions()) {
			return false;
		}
		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down")) {
			return false;
		}
		if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) {
			return false;
		}
		if (keyData === " " && this.allowsMultiple()) {
			return false;
		}
		return true;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// Navigate between question tabs (raw terminal bytes or canonical names).
		if (TAB_KEYS.has(keyData) || RIGHT_KEYS.has(keyData)) {
			this.nextTab();
			return;
		}
		if (SHIFT_TAB_KEYS.has(keyData) || LEFT_KEYS.has(keyData)) {
			this.prevTab();
			return;
		}

		if (this.isSubmitView) {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
				this.finish();
			}
			return;
		}

		if (!this.hasOptions()) {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
				this.commitCurrentAnswer();
				return;
			}
			this.input.handleInput(keyData);
			return;
		}

		if (this.isChatRowSelected() && (kb.matches(keyData, "tui.select.confirm") || keyData === "\n")) {
			this.chatAboutIt();
			return;
		}

		const maxIndex = this.chatRowIndex;
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.syncInputFocus();
			this.renderCurrentTab();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(maxIndex, this.selectedIndex + 1);
			this.syncInputFocus();
			this.renderCurrentTab();
			return;
		}

		if (this.allowsMultiple() && keyData === " " && this.selectedIndex < this.currentOptions.length) {
			if (this.checkedOptions.has(this.selectedIndex)) {
				this.checkedOptions.delete(this.selectedIndex);
			} else {
				this.checkedOptions.add(this.selectedIndex);
			}
			this.renderCurrentTab();
			return;
		}

		if (this.isCustomRowSelected() && !(kb.matches(keyData, "tui.select.confirm") || keyData === "\n")) {
			this.input.handleInput(keyData);
			return;
		}

		if (!this.isCustomRowSelected() && !this.isChatRowSelected() && this.shouldRouteToCustomInput(keyData)) {
			this.selectedIndex = this.customRowIndex;
			this.syncInputFocus();
			this.renderCurrentTab();
			this.input.handleInput(keyData);
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.commitCurrentAnswer();
		}
	}
}
