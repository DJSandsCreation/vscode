/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAnchor } from 'vs/base/browser/ui/contextview/contextview';
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Lazy } from 'vs/base/common/lazy';
import { Disposable } from 'vs/base/common/lifecycle';
import { escapeRegExpCharacters } from 'vs/base/common/strings';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { EditorAction, EditorCommand, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import { IPosition } from 'vs/editor/common/core/position';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { CodeAction } from 'vs/editor/common/modes';
import { CodeActionSet, refactorCommandId, sourceActionCommandId, codeActionCommandId, organizeImportsCommandId, fixAllCommandId } from 'vs/editor/contrib/codeAction/codeAction';
import { CodeActionUi } from 'vs/editor/contrib/codeAction/codeActionUi';
import { MessageController } from 'vs/editor/contrib/message/messageController';
import * as nls from 'vs/nls';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IMarkerService } from 'vs/platform/markers/common/markers';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IEditorProgressService } from 'vs/platform/progress/common/progress';
import { CodeActionModel, CodeActionsState, SUPPORTED_CODE_ACTIONS } from './codeActionModel';
import { CodeActionAutoApply, CodeActionFilter, CodeActionKind, CodeActionTrigger, CodeActionCommandArgs } from './types';

function contextKeyForSupportedActions(kind: CodeActionKind) {
	return ContextKeyExpr.regex(
		SUPPORTED_CODE_ACTIONS.keys()[0],
		new RegExp('(\\s|^)' + escapeRegExpCharacters(kind.value) + '\\b'));
}

const argsSchema: IJSONSchema = {
	type: 'object',
	required: ['kind'],
	defaultSnippets: [{ body: { kind: '' } }],
	properties: {
		'kind': {
			type: 'string',
			description: nls.localize('args.schema.kind', "Kind of the code action to run."),
		},
		'apply': {
			type: 'string',
			description: nls.localize('args.schema.apply', "Controls when the returned actions are applied."),
			default: CodeActionAutoApply.IfSingle,
			enum: [CodeActionAutoApply.First, CodeActionAutoApply.IfSingle, CodeActionAutoApply.Never],
			enumDescriptions: [
				nls.localize('args.schema.apply.first', "Always apply the first returned code action."),
				nls.localize('args.schema.apply.ifSingle', "Apply the first returned code action if it is the only one."),
				nls.localize('args.schema.apply.never', "Do not apply the returned code actions."),
			]
		},
		'preferred': {
			type: 'boolean',
			default: false,
			description: nls.localize('args.schema.preferred', "Controls if only preferred code actions should be returned."),
		}
	}
};

export class QuickFixController extends Disposable implements IEditorContribution {

	public static readonly ID = 'editor.contrib.quickFixController';

	public static get(editor: ICodeEditor): QuickFixController {
		return editor.getContribution<QuickFixController>(QuickFixController.ID);
	}

	private readonly _editor: ICodeEditor;
	private readonly _model: CodeActionModel;
	private readonly _ui: Lazy<CodeActionUi>;

	constructor(
		editor: ICodeEditor,
		@IMarkerService markerService: IMarkerService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorProgressService progressService: IEditorProgressService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService private readonly _commandService: ICommandService,
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._editor = editor;
		this._model = this._register(new CodeActionModel(this._editor, markerService, contextKeyService, progressService));
		this._register(this._model.onDidChangeState(newState => this.update(newState)));

		this._ui = new Lazy(() =>
			this._register(new CodeActionUi(editor, QuickFixAction.Id, AutoFixAction.Id, {
				applyCodeAction: async (action, retrigger) => {
					try {
						await this._applyCodeAction(action);
					} finally {
						if (retrigger) {
							this._trigger({ type: 'auto', filter: {} });
						}
					}
				}
			}, contextMenuService, keybindingService))
		);
	}

	private update(newState: CodeActionsState.State): void {
		this._ui.getValue().update(newState);
	}

	public showCodeActions(actions: CodeActionSet, at: IAnchor | IPosition) {
		return this._ui.getValue().showCodeActionList(actions, at);
	}

	public manualTriggerAtCurrentPosition(
		notAvailableMessage: string,
		filter?: CodeActionFilter,
		autoApply?: CodeActionAutoApply
	): void {
		if (!this._editor.hasModel()) {
			return;
		}

		MessageController.get(this._editor).closeMessage();
		const triggerPosition = this._editor.getPosition();
		this._trigger({ type: 'manual', filter, autoApply, context: { notAvailableMessage, position: triggerPosition } });
	}

	private _trigger(trigger: CodeActionTrigger) {
		return this._model.trigger(trigger);
	}

	private _applyCodeAction(action: CodeAction): Promise<void> {
		return this._instantiationService.invokeFunction(applyCodeAction, action, this._bulkEditService, this._commandService, this._editor);
	}
}

export async function applyCodeAction(
	accessor: ServicesAccessor,
	action: CodeAction,
	bulkEditService: IBulkEditService,
	commandService: ICommandService,
	editor?: ICodeEditor,
): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	if (action.edit) {
		await bulkEditService.apply(action.edit, { editor });
	}
	if (action.command) {
		try {
			await commandService.executeCommand(action.command.id, ...(action.command.arguments || []));
		} catch (err) {
			const message = asMessage(err);
			notificationService.error(
				typeof message === 'string'
					? message
					: nls.localize('applyCodeActionFailed', "An unknown error occurred while applying the code action"));

		}
	}
}

function asMessage(err: any): string | undefined {
	if (typeof err === 'string') {
		return err;
	} else if (err instanceof Error && typeof err.message === 'string') {
		return err.message;
	} else {
		return undefined;
	}
}

function triggerCodeActionsForEditorSelection(
	editor: ICodeEditor,
	notAvailableMessage: string,
	filter: CodeActionFilter | undefined,
	autoApply: CodeActionAutoApply | undefined
): void {
	if (editor.hasModel()) {
		const controller = QuickFixController.get(editor);
		if (controller) {
			controller.manualTriggerAtCurrentPosition(notAvailableMessage, filter, autoApply);
		}
	}
}

export class QuickFixAction extends EditorAction {

	static readonly Id = 'editor.action.quickFix';

	constructor() {
		super({
			id: QuickFixAction.Id,
			label: nls.localize('quickfix.trigger.label', "Quick Fix..."),
			alias: 'Quick Fix...',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.CtrlCmd | KeyCode.US_DOT,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		return triggerCodeActionsForEditorSelection(editor, nls.localize('editor.action.quickFix.noneMessage', "No code actions available"), undefined, undefined);
	}
}

export class CodeActionCommand extends EditorCommand {

	constructor() {
		super({
			id: codeActionCommandId,
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider),
			description: {
				description: `Trigger a code action`,
				args: [{
					name: 'args',
					schema: argsSchema,
				}]
			}
		});
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor, userArgs: any) {
		const args = CodeActionCommandArgs.fromUser(userArgs, {
			kind: CodeActionKind.Empty,
			apply: CodeActionAutoApply.IfSingle,
		});
		return triggerCodeActionsForEditorSelection(editor,
			typeof userArgs?.kind === 'string'
				? args.preferred
					? nls.localize('editor.action.codeAction.noneMessage.preferred.kind', "No preferred code actions for '{0}' available", userArgs.kind)
					: nls.localize('editor.action.codeAction.noneMessage.kind', "No code actions for '{0}' available", userArgs.kind)
				: args.preferred
					? nls.localize('editor.action.codeAction.noneMessage.preferred', "No preferred code actions available")
					: nls.localize('editor.action.codeAction.noneMessage', "No code actions available"),
			{
				kind: args.kind,
				includeSourceActions: true,
				onlyIncludePreferredActions: args.preferred,
			},
			args.apply);
	}
}


export class RefactorAction extends EditorAction {

	constructor() {
		super({
			id: refactorCommandId,
			label: nls.localize('refactor.label', "Refactor..."),
			alias: 'Refactor...',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_R,
				mac: {
					primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KEY_R
				},
				weight: KeybindingWeight.EditorContrib
			},
			menuOpts: {
				group: '1_modification',
				order: 2,
				when: ContextKeyExpr.and(
					EditorContextKeys.writable,
					contextKeyForSupportedActions(CodeActionKind.Refactor)),
			},
			description: {
				description: 'Refactor...',
				args: [{
					name: 'args',
					schema: argsSchema
				}]
			}
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor, userArgs: any): void {
		const args = CodeActionCommandArgs.fromUser(userArgs, {
			kind: CodeActionKind.Refactor,
			apply: CodeActionAutoApply.Never
		});
		return triggerCodeActionsForEditorSelection(editor,
			typeof userArgs?.kind === 'string'
				? args.preferred
					? nls.localize('editor.action.refactor.noneMessage.preferred.kind', "No preferred refactorings for '{0}' available", userArgs.kind)
					: nls.localize('editor.action.refactor.noneMessage.kind', "No refactorings for '{0}' available", userArgs.kind)
				: args.preferred
					? nls.localize('editor.action.refactor.noneMessage.preferred', "No preferred refactorings available")
					: nls.localize('editor.action.refactor.noneMessage', "No refactorings available"),
			{
				kind: CodeActionKind.Refactor.contains(args.kind) ? args.kind : CodeActionKind.None,
				onlyIncludePreferredActions: args.preferred,
			},
			args.apply);
	}
}

export class SourceAction extends EditorAction {

	constructor() {
		super({
			id: sourceActionCommandId,
			label: nls.localize('source.label', "Source Action..."),
			alias: 'Source Action...',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider),
			menuOpts: {
				group: '1_modification',
				order: 2.1,
				when: ContextKeyExpr.and(
					EditorContextKeys.writable,
					contextKeyForSupportedActions(CodeActionKind.Source)),
			},
			description: {
				description: 'Source Action...',
				args: [{
					name: 'args',
					schema: argsSchema
				}]
			}
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor, userArgs: any): void {
		const args = CodeActionCommandArgs.fromUser(userArgs, {
			kind: CodeActionKind.Source,
			apply: CodeActionAutoApply.Never
		});
		return triggerCodeActionsForEditorSelection(editor,
			typeof userArgs?.kind === 'string'
				? args.preferred
					? nls.localize('editor.action.source.noneMessage.preferred.kind', "No preferred source actions for '{0}' available", userArgs.kind)
					: nls.localize('editor.action.source.noneMessage.kind', "No source actions for '{0}' available", userArgs.kind)
				: args.preferred
					? nls.localize('editor.action.source.noneMessage.preferred', "No preferred source actions available")
					: nls.localize('editor.action.source.noneMessage', "No source actions available"),
			{
				kind: CodeActionKind.Source.contains(args.kind) ? args.kind : CodeActionKind.None,
				includeSourceActions: true,
				onlyIncludePreferredActions: args.preferred,
			},
			args.apply);
	}
}

export class OrganizeImportsAction extends EditorAction {

	constructor() {
		super({
			id: organizeImportsCommandId,
			label: nls.localize('organizeImports.label', "Organize Imports"),
			alias: 'Organize Imports',
			precondition: ContextKeyExpr.and(
				EditorContextKeys.writable,
				contextKeyForSupportedActions(CodeActionKind.SourceOrganizeImports)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KEY_O,
				weight: KeybindingWeight.EditorContrib
			},
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		return triggerCodeActionsForEditorSelection(editor,
			nls.localize('editor.action.organize.noneMessage', "No organize imports action available"),
			{ kind: CodeActionKind.SourceOrganizeImports, includeSourceActions: true },
			CodeActionAutoApply.IfSingle);
	}
}

export class FixAllAction extends EditorAction {

	constructor() {
		super({
			id: fixAllCommandId,
			label: nls.localize('fixAll.label', "Fix All"),
			alias: 'Fix All',
			precondition: ContextKeyExpr.and(
				EditorContextKeys.writable,
				contextKeyForSupportedActions(CodeActionKind.SourceFixAll))
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		return triggerCodeActionsForEditorSelection(editor,
			nls.localize('fixAll.noneMessage', "No fix all action available"),
			{ kind: CodeActionKind.SourceFixAll, includeSourceActions: true },
			CodeActionAutoApply.IfSingle);
	}
}

export class AutoFixAction extends EditorAction {

	static readonly Id = 'editor.action.autoFix';

	constructor() {
		super({
			id: AutoFixAction.Id,
			label: nls.localize('autoFix.label', "Auto Fix..."),
			alias: 'Auto Fix...',
			precondition: ContextKeyExpr.and(
				EditorContextKeys.writable,
				contextKeyForSupportedActions(CodeActionKind.QuickFix)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.Alt | KeyMod.Shift | KeyCode.US_DOT,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.US_DOT
				},
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		return triggerCodeActionsForEditorSelection(editor,
			nls.localize('editor.action.autoFix.noneMessage', "No auto fixes available"),
			{
				kind: CodeActionKind.QuickFix,
				onlyIncludePreferredActions: true
			},
			CodeActionAutoApply.IfSingle);
	}
}
