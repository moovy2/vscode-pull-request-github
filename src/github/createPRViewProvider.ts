/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChooseBaseRemoteAndBranchResult, ChooseCompareRemoteAndBranchResult, ChooseRemoteAndBranchArgs, CreateParamsNew, CreatePullRequestNew, RemoteInfo, TitleAndDescriptionArgs } from '../../common/views';
import type { Branch, Ref } from '../api/api';
import { GitHubServerType } from '../common/authentication';
import { emojify, ensureEmojis } from '../common/emoji';
import { commands, contexts } from '../common/executeCommands';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { GitHubRemote } from '../common/remote';
import {
	ASSIGN_TO,
	CREATE_BASE_BRANCH,
	DEFAULT_CREATE_OPTION,
	PR_SETTINGS_NAMESPACE,
	PULL_REQUEST_DESCRIPTION,
	PULL_REQUEST_LABELS,
	PUSH_BRANCH
} from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { asPromise, compareIgnoreCase, formatError, promiseWithTimeout } from '../common/utils';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { PREVIOUS_CREATE_METHOD } from '../extensionState';
import { CreatePullRequestDataModel } from '../view/createPullRequestDataModel';
import {
	byRemoteName,
	FolderRepositoryManager,
	PullRequestDefaults,
	titleAndBodyFrom,
} from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { IAccount, ILabel, IMilestone, IProject, isTeam, ITeam, MergeMethod, RepoAccessAndMergeMethods } from './interface';
import { BaseBranchMetadata, PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { getAssigneesQuickPickItems, getLabelOptions, getMilestoneFromQuickPick, getProjectFromQuickPick, reviewersQuickPick } from './quickPicks';
import { getIssueNumberLabelFromParsed, ISSUE_EXPRESSION, ISSUE_OR_URL_EXPRESSION, parseIssueExpressionOutput, variableSubstitution } from './utils';
import { DisplayLabel, PreReviewState } from './views';

const ISSUE_CLOSING_KEYWORDS = new RegExp('closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve\s$', 'i'); // https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword

export interface BasePullRequestDataModel {
	baseOwner: string;
	repositoryName: string;
}

export abstract class BaseCreatePullRequestViewProvider<T extends BasePullRequestDataModel = BasePullRequestDataModel> extends WebviewViewBase implements vscode.WebviewViewProvider {
	protected static readonly ID = 'CreatePullRequestViewProvider';
	public override readonly viewType = 'github:createPullRequestWebview';

	protected _onDone = new vscode.EventEmitter<PullRequestModel | undefined>();
	readonly onDone: vscode.Event<PullRequestModel | undefined> = this._onDone.event;

	protected _firstLoad: boolean = true;

	constructor(
		protected readonly telemetry: ITelemetry,
		protected readonly model: T,
		extensionUri: vscode.Uri,
		protected readonly _folderRepositoryManager: FolderRepositoryManager,
		protected readonly _pullRequestDefaults: PullRequestDefaults,
		protected _defaultCompareBranch: string
	) {
		super(extensionUri);
	}

	public override resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		super.resolveWebviewView(webviewView, _context, _token);
		webviewView.webview.html = this._getHtmlForWebview();

		if (this._firstLoad) {
			this._firstLoad = false;
			// Reset any stored state.
			return this.initializeParams(true);
		} else {
			return this.initializeParams();
		}
	}

	public override show() {
		super.show();
	}

	public static withProgress<R>(task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<R>) {
		return vscode.window.withProgress({ location: { viewId: 'github:createPullRequestWebview' } }, task);
	}

	protected async getPullRequestDefaultLabels(defaultBaseRemote: RemoteInfo): Promise<ILabel[]> {

		const pullRequestLabelSettings = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).inspect<string[]>(PULL_REQUEST_LABELS);

		if (!pullRequestLabelSettings) {
			return [];
		}

		const defaultLabelValues = new Array<string>();

		if (pullRequestLabelSettings.workspaceValue) {
			defaultLabelValues.push(...pullRequestLabelSettings.workspaceValue);
		}
		if (pullRequestLabelSettings.globalValue) {
			defaultLabelValues.push(...pullRequestLabelSettings.globalValue);
		}

		// Return early if no config present
		if (!defaultLabelValues || defaultLabelValues.length === 0) {
			return [];
		}

		// Fetch labels from the repo and filter with case-sensitive comparison to be safe,
		// dropping any labels that don't exist on the repo.
		// TODO: @alexr00 - Add a cache for this.
		const labels = await this._folderRepositoryManager.getLabels(undefined, { owner: defaultBaseRemote.owner, repo: defaultBaseRemote.repositoryName });
		const defaultLabels = labels.filter(label => defaultLabelValues.includes(label.name));

		return defaultLabels;
	}

	protected abstract getTitleAndDescription(compareBranch: Branch, baseBranch: string): Promise<{ title: string, description: string }>;

	protected async getMergeConfiguration(owner: string, name: string, refetch: boolean = false): Promise<RepoAccessAndMergeMethods> {
		const repo = await this._folderRepositoryManager.createGitHubRepositoryFromOwnerName(owner, name);
		return repo.getRepoAccessAndMergeMethods(refetch);
	}

	private initializeWhenVisibleDisposable: vscode.Disposable | undefined;
	public async initializeParams(reset: boolean = false): Promise<void> {
		if (this._view?.visible === false && this.initializeWhenVisibleDisposable === undefined) {
			this.initializeWhenVisibleDisposable = this._view?.onDidChangeVisibility(() => {
				this.initializeWhenVisibleDisposable?.dispose();
				this.initializeWhenVisibleDisposable = undefined;
				void this.initializeParams();
			});
			return;
		}

		if (reset) {
			// First clear all state ASAP
			this._postMessage({ command: 'reset' });
		}
		await this.initializeParamsPromise();
	}

	private _alreadyInitializing: Promise<CreateParamsNew> | undefined;
	private async initializeParamsPromise(): Promise<CreateParamsNew> {
		if (!this._alreadyInitializing) {
			this._alreadyInitializing = this.doInitializeParams();
			this._alreadyInitializing.then(() => {
				this._alreadyInitializing = undefined;
			});
		}
		return this._alreadyInitializing;
	}

	protected abstract detectBaseMetadata(defaultCompareBranch: Branch): Promise<BaseBranchMetadata | undefined>;

	protected getTitleAndDescriptionProvider(name?: string) {
		return this._folderRepositoryManager.getTitleAndDescriptionProvider(name);
	}

	protected async getCreateParams(): Promise<CreateParamsNew> {
		const defaultCompareBranch = await this._folderRepositoryManager.repository.getBranch(this._defaultCompareBranch);
		const [detectedBaseMetadata, remotes, defaultOrigin] = await Promise.all([
			this.detectBaseMetadata(defaultCompareBranch),
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.getOrigin(defaultCompareBranch),
			ensureEmojis(this._folderRepositoryManager.context)
		]);

		const defaultBaseRemote: RemoteInfo = {
			owner: detectedBaseMetadata?.owner ?? this._pullRequestDefaults.owner,
			repositoryName: detectedBaseMetadata?.repositoryName ?? this._pullRequestDefaults.repo,
		};

		const defaultCompareRemote: RemoteInfo = {
			owner: defaultOrigin.remote.owner,
			repositoryName: defaultOrigin.remote.repositoryName,
		};

		const defaultBaseBranch = detectedBaseMetadata?.branch ?? this._pullRequestDefaults.base;

		const [defaultTitleAndDescription, mergeConfiguration, viewerPermission, mergeQueueMethodForBranch, labels] = await Promise.all([
			this.getTitleAndDescription(defaultCompareBranch, defaultBaseBranch),
			this.getMergeConfiguration(defaultBaseRemote.owner, defaultBaseRemote.repositoryName),
			defaultOrigin.getViewerPermission(),
			this._folderRepositoryManager.mergeQueueMethodForBranch(defaultBaseBranch, defaultBaseRemote.owner, defaultBaseRemote.repositoryName),
			this.getPullRequestDefaultLabels(defaultBaseRemote)
		]);

		const defaultCreateOption = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'lastUsed' | 'create' | 'createDraft' | 'createAutoMerge'>(DEFAULT_CREATE_OPTION, 'lastUsed');
		const lastCreateMethod: { autoMerge: boolean, mergeMethod: MergeMethod | undefined, isDraft: boolean } | undefined = this._folderRepositoryManager.context.workspaceState.get<{ autoMerge: boolean, mergeMethod: MergeMethod, isDraft } | undefined>(PREVIOUS_CREATE_METHOD, undefined);
		const repoMergeMethod = getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability);

		// default values are for 'create'
		let defaultMergeMethod: MergeMethod = repoMergeMethod;
		let isDraftDefault: boolean = false;
		let autoMergeDefault: boolean = false;
		defaultMergeMethod = (defaultCreateOption === 'lastUsed' && lastCreateMethod?.mergeMethod) ? lastCreateMethod?.mergeMethod : repoMergeMethod;

		if (defaultCreateOption === 'lastUsed') {
			defaultMergeMethod = lastCreateMethod?.mergeMethod ?? repoMergeMethod;
			isDraftDefault = !!lastCreateMethod?.isDraft;
			autoMergeDefault = mergeConfiguration.viewerCanAutoMerge && !!lastCreateMethod?.autoMerge;
		} else if (defaultCreateOption === 'createDraft') {
			isDraftDefault = true;
		} else if (defaultCreateOption === 'createAutoMerge') {
			autoMergeDefault = mergeConfiguration.viewerCanAutoMerge;
		}
		commands.setContext(contexts.CREATE_PR_PERMISSIONS, viewerPermission);

		const useCopilot: boolean = !!this.getTitleAndDescriptionProvider('Copilot') && (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'commit' | 'template' | 'none' | 'Copilot'>(PULL_REQUEST_DESCRIPTION) === 'Copilot');
		const defaultTitleAndDescriptionProvider = this.getTitleAndDescriptionProvider()?.title;
		if (defaultTitleAndDescriptionProvider) {
			/* __GDPR__
				"pr.defaultTitleAndDescriptionProvider" : {
					"providerTitle" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryEvent('pr.defaultTitleAndDescriptionProvider', { providerTitle: defaultTitleAndDescriptionProvider });
		}
		const preReviewer = this._folderRepositoryManager.getAutoReviewer();

		this.labels = labels.map(label => ({ ...label, displayName: emojify(label.name) }));

		const params: CreateParamsNew = {
			canModifyBranches: true,
			defaultBaseRemote,
			defaultBaseBranch,
			defaultCompareRemote,
			defaultCompareBranch: this._defaultCompareBranch,
			defaultTitle: defaultTitleAndDescription.title,
			defaultDescription: defaultTitleAndDescription.description,
			defaultMergeMethod,
			baseHasMergeQueue: !!mergeQueueMethodForBranch,
			remoteCount: remotes.length,
			allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
			mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
			autoMergeDefault,
			createError: '',
			labels: this.labels,
			isDraftDefault,
			isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
			generateTitleAndDescriptionTitle: defaultTitleAndDescriptionProvider,
			creating: false,
			initializeWithGeneratedTitleAndDescription: useCopilot,
			preReviewState: PreReviewState.None,
			preReviewer: preReviewer?.title,
			reviewing: false
		};

		return params;
	}

	private async doInitializeParams(): Promise<CreateParamsNew> {
		const params = await this.getCreateParams();

		Logger.appendLine(`Initializing "create" view: ${JSON.stringify(params)}`, BaseCreatePullRequestViewProvider.ID);

		this._postMessage({
			command: 'pr.initialize',
			params,
		});
		return params;
	}

	private async autoAssign(pr: PullRequestModel): Promise<void> {
		const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string | undefined>(ASSIGN_TO);
		if (!configuration) {
			return;
		}
		const resolved = await variableSubstitution(configuration, pr, undefined, (await this._folderRepositoryManager.getCurrentUser(pr.githubRepository))?.login);
		if (!resolved) {
			return;
		}
		try {
			const user = await pr.githubRepository.resolveUser(resolved);
			if (user) {
				await pr.replaceAssignees([user]);
			}
		} catch (e) {
			Logger.error(`Unable to assign pull request to user ${resolved}.`, BaseCreatePullRequestViewProvider.ID);
		}
	}

	private async enableAutoMerge(pr: PullRequestModel, autoMerge: boolean, automergeMethod: MergeMethod | undefined): Promise<void> {
		if (autoMerge && automergeMethod) {
			return pr.enableAutoMerge(automergeMethod);
		}
	}

	private async setLabels(pr: PullRequestModel, labels: ILabel[]): Promise<void> {
		if (labels.length > 0) {
			await pr.setLabels(labels.map(label => label.name));
		}
	}

	private async setAssignees(pr: PullRequestModel, assignees: IAccount[]): Promise<void> {
		if (assignees.length) {
			await pr.replaceAssignees(assignees);
		} else {
			await this.autoAssign(pr);
		}
	}

	private async setReviewers(pr: PullRequestModel, reviewers: (IAccount | ITeam)[]): Promise<void> {
		if (reviewers.length) {
			const users: IAccount[] = [];
			const teams: ITeam[] = [];
			for (const reviewer of reviewers) {
				if (isTeam(reviewer)) {
					teams.push(reviewer);
				} else {
					users.push(reviewer);
				}
			}
			await pr.requestReview(users, teams, true);
		}
	}

	private setMilestone(pr: PullRequestModel, milestone: IMilestone | undefined) {
		if (milestone) {
			return pr.updateMilestone(milestone.id);
		}
	}

	private setProjects(pr: PullRequestModel, projects: IProject[]) {
		if (projects.length) {
			return pr.updateProjects(projects);
		}
	}

	private async getBaseRemote(): Promise<GitHubRemote> {
		return (await this._folderRepositoryManager.getGitHubRemotes()).find(remote => compareIgnoreCase(remote.owner, this.model.baseOwner) === 0 && compareIgnoreCase(remote.repositoryName, this.model.repositoryName) === 0)!;
	}

	private getBaseGitHubRepo(): GitHubRepository | undefined {
		return this._folderRepositoryManager.gitHubRepositories.find(repo => compareIgnoreCase(repo.remote.owner, this.model.baseOwner) === 0 && compareIgnoreCase(repo.remote.repositoryName, this.model.repositoryName) === 0);
	}

	private milestone: IMilestone | undefined;
	public async addMilestone(): Promise<void> {
		const remote = await this.getBaseRemote();
		const repo = this._folderRepositoryManager.gitHubRepositories.find(repo => repo.remote.remoteName === remote.remoteName)!;

		return getMilestoneFromQuickPick(this._folderRepositoryManager, repo, this.milestone, (milestone) => {
			this.milestone = milestone;
			return this._postMessage({
				command: 'set-milestone',
				params: { milestone: this.milestone }
			});
		});
	}

	private reviewers: (IAccount | ITeam)[] = [];
	public async addReviewers(): Promise<void> {
		let quickPick: vscode.QuickPick<vscode.QuickPickItem & {
			user?: IAccount | ITeam | undefined;
		}> | undefined;
		const remote = await this.getBaseRemote();
		try {
			const repo = this._folderRepositoryManager.gitHubRepositories.find(repo => repo.remote.remoteName === remote.remoteName)!;
			const [metadata, author, teamsCount] = await Promise.all([repo?.getMetadata(), this._folderRepositoryManager.getCurrentUser(), this._folderRepositoryManager.getOrgTeamsCount(repo)]);
			quickPick = await reviewersQuickPick(this._folderRepositoryManager, remote.remoteName, !!metadata?.organization, teamsCount, author, this.reviewers.map(reviewer => { return { reviewer, state: 'REQUESTED' }; }), []);
			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick!.selectedItems.filter(item => item.user) as (vscode.QuickPickItem & { user: IAccount | ITeam })[] | undefined;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allReviewers = await Promise.race<(vscode.QuickPickItem & { user: IAccount | ITeam })[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;

			if (allReviewers) {
				this.reviewers = allReviewers.map(item => item.user);
				this._postMessage({
					command: 'set-reviewers',
					params: { reviewers: this.reviewers }
				});
			}
		} catch (e) {
			Logger.error(`Failed to add reviewers: ${formatError(e)}`, BaseCreatePullRequestViewProvider.ID);
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick?.hide();
			quickPick?.dispose();
		}
	}

	private assignees: IAccount[] = [];
	public async addAssignees(): Promise<void> {
		const remote = await this.getBaseRemote();
		const currentRepo = this._folderRepositoryManager.gitHubRepositories.find(repo => repo.remote.owner === remote.owner && repo.remote.repositoryName === remote.repositoryName);
		const assigneesToAdd = await vscode.window.showQuickPick(getAssigneesQuickPickItems(this._folderRepositoryManager, currentRepo, remote.remoteName, this.assignees, undefined, true),
			{ canPickMany: true, matchOnDescription: true, placeHolder: vscode.l10n.t('Add assignees') });
		if (assigneesToAdd) {
			const seenNewAssignees = new Set<string>();
			const addedAssignees = assigneesToAdd.map(assignee => assignee.user).filter<IAccount>((assignee): assignee is IAccount => {
				if (assignee && !seenNewAssignees.has(assignee.login)) {
					seenNewAssignees.add(assignee.login);
					return true;
				}
				return false;
			});
			this.assignees = addedAssignees;
			this._postMessage({
				command: 'set-assignees',
				params: { assignees: this.assignees }
			});
		}
	}
	private projects: IProject[] = [];
	public async addProjects(): Promise<void> {
		const githubRepo = this.getBaseGitHubRepo();
		if (!githubRepo) {
			return;
		}
		await new Promise<void>((resolve) => {
			getProjectFromQuickPick(this._folderRepositoryManager, githubRepo, this.projects, async (projects) => {
				this.projects = projects;
				this._postMessage({
					command: 'set-projects',
					params: { projects: this.projects }
				});
				resolve();
			});
		});
	}

	private labels: DisplayLabel[] = [];
	public async addLabels(): Promise<void> {
		let newLabels: DisplayLabel[] = [];

		const labelsToAdd = await vscode.window.showQuickPick<vscode.QuickPickItem & { name: string }>(
			getLabelOptions(this._folderRepositoryManager, this.labels, this.model.baseOwner, this.model.repositoryName).then(options => {
				newLabels = options.newLabels;
				return options.labelPicks;
			}),
			{ canPickMany: true, matchOnDescription: true, placeHolder: vscode.l10n.t('Apply labels') },
		);

		if (labelsToAdd) {
			const addedLabels: DisplayLabel[] = labelsToAdd.map(label => newLabels.find(l => l.name === label.name)!);
			this.labels = addedLabels;
			this._postMessage({
				command: 'set-labels',
				params: { labels: this.labels }
			});
		}
	}

	private async removeLabel(message: IRequestMessage<{ label: ILabel }>,): Promise<void> {
		const { label } = message.args;
		if (!label)
			return;

		const previousLabelsLength = this.labels.length;
		this.labels = this.labels.filter(l => l.name !== label.name);
		if (previousLabelsLength === this.labels.length)
			return;

		this._postMessage({
			command: 'set-labels',
			params: { labels: this.labels }
		});
	}

	public async createFromCommand(isDraft: boolean, autoMerge: boolean, autoMergeMethod: MergeMethod | undefined, mergeWhenReady?: boolean) {
		const params: Partial<CreateParamsNew> = {
			isDraft,
			autoMerge,
			autoMergeMethod: mergeWhenReady ? 'merge' : autoMergeMethod,
			creating: true
		};
		return this._postMessage({
			command: 'create',
			params
		});
	}

	protected abstract create(message: IRequestMessage<CreatePullRequestNew>): Promise<void>;

	protected async postCreate(message: IRequestMessage<CreatePullRequestNew>, createdPR: PullRequestModel) {
		return Promise.all([
			this.setLabels(createdPR, message.args.labels),
			this.enableAutoMerge(createdPR, message.args.autoMerge, message.args.autoMergeMethod),
			this.setAssignees(createdPR, message.args.assignees),
			this.setReviewers(createdPR, message.args.reviewers),
			this.setMilestone(createdPR, message.args.milestone),
			this.setProjects(createdPR, message.args.projects)]);
	}

	private async cancel(message: IRequestMessage<CreatePullRequestNew>) {
		this._onDone.fire(undefined);
		// Re-fetch the automerge info so that it's updated for next time.
		await this.getMergeConfiguration(message.args.owner, message.args.repo, true);
		return this._replyMessage(message, undefined);
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'pr.requestInitialize':
				return this.initializeParamsPromise();

			case 'pr.cancelCreate':
				return this.cancel(message);

			case 'pr.create':
				return this.create(message);

			case 'pr.changeLabels':
				return this.addLabels();

			case 'pr.changeReviewers':
				return this.addReviewers();

			case 'pr.changeAssignees':
				return this.addAssignees();

			case 'pr.changeMilestone':
				return this.addMilestone();

			case 'pr.changeProjects':
				return this.addProjects();

			case 'pr.removeLabel':
				return this.removeLabel(message);

			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	override dispose() {
		super.dispose();
		this._postMessage({ command: 'reset' });
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-create-pr-view-new.js');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">

		<title>Create Pull Request</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}
}

function serializeRemoteInfo(remote: { owner: string, repositoryName: string }) {
	return { owner: remote.owner, repositoryName: remote.repositoryName };
}

export class CreatePullRequestViewProvider extends BaseCreatePullRequestViewProvider<CreatePullRequestDataModel> implements vscode.WebviewViewProvider {
	public override readonly viewType = 'github:createPullRequestWebview';

	constructor(
		telemetry: ITelemetry,
		model: CreatePullRequestDataModel,
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		pullRequestDefaults: PullRequestDefaults,
	) {
		super(telemetry, model, extensionUri, folderRepositoryManager, pullRequestDefaults, model.compareBranch);

		this._register(this.model.onDidChange(async (e) => {
			let baseRemote: RemoteInfo | undefined;
			let baseBranch: string | undefined;
			if (e.baseOwner) {
				const gitHubRemote = this._folderRepositoryManager.findRepo(repo => compareIgnoreCase(repo.remote.owner, e.baseOwner!) === 0 && compareIgnoreCase(repo.remote.repositoryName, this.model.repositoryName) === 0)?.remote;
				baseRemote = gitHubRemote ? serializeRemoteInfo(gitHubRemote) : undefined;
				baseBranch = this.model.baseBranch;
			}
			if (e.baseBranch) {
				baseBranch = e.baseBranch;
			}
			let compareRemote: RemoteInfo | undefined;
			let compareBranch: string | undefined;
			if (e.compareOwner) {
				const gitHubRemote = this._folderRepositoryManager.findRepo(repo => compareIgnoreCase(repo.remote.owner, e.compareOwner!) === 0 && compareIgnoreCase(repo.remote.repositoryName, this.model.repositoryName) === 0)?.remote;
				compareRemote = gitHubRemote ? serializeRemoteInfo(gitHubRemote) : undefined;
				compareBranch = this.model.compareBranch;
			}
			if (e.compareBranch) {
				compareBranch = e.compareBranch;
			}
			const params: Partial<CreateParamsNew> = {
				baseRemote,
				baseBranch,
				compareRemote,
				compareBranch,
				warning: await this.existingPRMessage(),
			};
			// TODO: consider updating title and description
			return this._postMessage({
				command: 'pr.initialize',
				params,
			});

		}));
	}

	private async existingPRMessage(): Promise<string | undefined> {
		const [existingPR, hasUpstream] = await Promise.all([PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this._folderRepositoryManager.repository, this.model.compareBranch), this.model.getCompareHasUpstream()]);
		if (!existingPR || !hasUpstream) {
			return undefined;
		}

		const [pr, compareBranch] = await Promise.all([await this._folderRepositoryManager.resolvePullRequest(existingPR.owner, existingPR.repositoryName, existingPR.prNumber), this._folderRepositoryManager.repository.getBranch(this.model.compareBranch)]);
		return (pr?.head?.sha === compareBranch.commit) ? vscode.l10n.t('A pull request already exists for this branch.') : undefined;
	}

	public async setDefaultCompareBranch(compareBranch: Branch | undefined) {
		const branchChanged = compareBranch && (compareBranch.name !== this.model.compareBranch);
		const currentCompareRemote = this._folderRepositoryManager.gitHubRepositories.find(repo => repo.remote.owner === this.model.compareOwner)?.remote.remoteName;
		const branchRemoteChanged = compareBranch && (compareBranch.upstream?.remote !== currentCompareRemote);
		if (branchChanged || branchRemoteChanged) {
			this._defaultCompareBranch = compareBranch!.name!;
			this.model.setCompareBranch(compareBranch!.name);
			this.changeBranch(compareBranch!.name!, false).then(async titleAndDescription => {
				const params: Partial<CreateParamsNew> = {
					defaultTitle: titleAndDescription.title,
					defaultDescription: titleAndDescription.description,
					compareBranch: compareBranch?.name,
					defaultCompareBranch: compareBranch?.name,
					warning: await this.existingPRMessage(),
				};
				if (!branchRemoteChanged) {
					return this._postMessage({
						command: 'pr.initialize',
						params,
					});
				}
			});
		}
	}

	public override show(compareBranch?: Branch): void {
		if (compareBranch) {
			this.setDefaultCompareBranch(compareBranch); // don't await, view will be updated when the branch is changed
		}

		super.show();
	}

	private async getTotalGitHubCommits(compareBranch: Branch, baseBranchName: string): Promise<{ commit: { message: string }; parents: { sha: string }[] }[] | undefined> {
		const origin = await this._folderRepositoryManager.getOrigin(compareBranch);

		if (compareBranch.upstream) {
			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(compareBranch.upstream.remote));

			if (headRepo) {
				const headBranch = `${headRepo.remote.owner}:${compareBranch.name ?? ''}`;
				const baseBranch = `${this._pullRequestDefaults.owner}:${baseBranchName}`;
				const compareResult = await origin.compareCommits(baseBranch, headBranch);

				return compareResult?.commits;
			}
		}

		return undefined;
	}

	protected async getTitleAndDescription(compareBranch: Branch, baseBranch: string): Promise<{ title: string, description: string }> {
		let title: string = '';
		let description: string = '';
		const descrptionSource = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'commit' | 'template' | 'none' | 'Copilot'>(PULL_REQUEST_DESCRIPTION);
		if (descrptionSource === 'none') {
			return { title, description };
		}

		// Use same default as GitHub, if there is only one commit, use the commit, otherwise use the branch name, as long as it is not the default branch.
		// By default, the base branch we use for comparison is the base branch of origin. Compare this to the
		// compare branch if it has a GitHub remote.
		const origin = await this._folderRepositoryManager.getOrigin(compareBranch);

		let useBranchName = this._pullRequestDefaults.base === compareBranch.name;
		Logger.debug(`Compare branch name: ${compareBranch.name}, Base branch name: ${this._pullRequestDefaults.base}`, CreatePullRequestViewProvider.ID);
		try {
			const name = compareBranch.name;
			const [totalCommits, lastCommit, pullRequestTemplate] = await Promise.all([
				this.getTotalGitHubCommits(compareBranch, baseBranch),
				name ? titleAndBodyFrom(promiseWithTimeout(this._folderRepositoryManager.getTipCommitMessage(name), 5000)) : undefined,
				descrptionSource === 'template' ? await this.getPullRequestTemplate() : undefined
			]);
			const totalNonMergeCommits = totalCommits?.filter(commit => commit.parents.length < 2);

			Logger.debug(`Total commits: ${totalNonMergeCommits?.length}`, CreatePullRequestViewProvider.ID);
			if (totalNonMergeCommits === undefined) {
				// There is no upstream branch. Use the last commit as the title and description.
				useBranchName = false;
			} else if (totalNonMergeCommits && totalNonMergeCommits.length > 1) {
				const defaultBranch = await origin.getDefaultBranch();
				useBranchName = defaultBranch !== compareBranch.name;
			}

			if (name && !lastCommit) {
				Logger.appendLine('Timeout getting last commit message', CreatePullRequestViewProvider.ID);
				/* __GDPR__
					"pr.create.getCommitTimeout" : {}
				*/
				this.telemetry.sendTelemetryEvent('pr.create.getCommitTimeout');
			}
			// Set title
			if (useBranchName && name) {
				title = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
			} else if (name && lastCommit) {
				title = lastCommit.title;
			}

			// Set description
			if (pullRequestTemplate && lastCommit?.body) {
				description = `${lastCommit.body}\n\n${pullRequestTemplate}`;
			} else if (pullRequestTemplate) {
				description = pullRequestTemplate;
			} else if (lastCommit?.body && (this._pullRequestDefaults.base !== compareBranch.name)) {
				description = lastCommit.body;
			}

			// If the description is empty, check to see if the title of the PR contains something that looks like an issue
			if (!description) {
				const issueExpMatch = title.match(ISSUE_EXPRESSION);
				const match = parseIssueExpressionOutput(issueExpMatch);
				if (match?.issueNumber && !match.name && !match.owner) {
					description = `#${match.issueNumber}`;
					const prefix = title.substr(0, title.indexOf(issueExpMatch![0]));

					const keyWordMatch = prefix.match(ISSUE_CLOSING_KEYWORDS);
					if (keyWordMatch) {
						description = `${keyWordMatch[0]} ${description}`;
					}
				}
			}
		} catch (e) {
			// Ignore and fall back to commit message
			Logger.debug(`Error while getting total commits: ${e}`, CreatePullRequestViewProvider.ID);
		}
		return { title, description };
	}

	private async getPullRequestTemplate(): Promise<string | undefined> {
		return this._folderRepositoryManager.getPullRequestTemplateBody(this.model.baseOwner);
	}

	protected async detectBaseMetadata(defaultCompareBranch: Branch): Promise<BaseBranchMetadata | undefined> {
		const owner = this.model.compareOwner;
		const repositoryName = this.model.repositoryName;
		const settingValue = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'repositoryDefault' | 'createdFromBranch' | 'auto'>(CREATE_BASE_BRANCH);
		if (!defaultCompareBranch.name || settingValue === 'repositoryDefault') {
			return undefined;
		}
		const githubRepo = this._folderRepositoryManager.findRepo(repo => compareIgnoreCase(repo.remote.owner, owner) === 0 && compareIgnoreCase(repo.remote.repositoryName, repositoryName) === 0);
		if (settingValue === 'auto' && (await githubRepo?.getMetadata())?.fork) {
			return undefined;
		}

		try {
			const baseFromProvider = await this._folderRepositoryManager.repository.getBranchBase(defaultCompareBranch.name);
			if (baseFromProvider?.name) {
				const repo = this._folderRepositoryManager.findRepo(repo => repo.remote.remoteName === baseFromProvider.remote);
				if (repo) {
					return {
						branch: baseFromProvider.name,
						owner: repo.remote.owner,
						repositoryName: repo.remote.repositoryName
					};
				}
			}
		} catch (e) {
			// Not all providers will support `getBranchBase`
			return undefined;
		}
	}

	protected override async getCreateParams(): Promise<CreateParamsNew> {
		const params = await super.getCreateParams();
		this.model.baseOwner = params.defaultBaseRemote!.owner;
		this.model.baseBranch = params.defaultBaseBranch!;
		return params;
	}


	private async remotePicks(isBase: boolean): Promise<(vscode.QuickPickItem & { remote?: RemoteInfo })[]> {
		const remotes = isBase ? await this._folderRepositoryManager.getActiveGitHubRemotes(await this._folderRepositoryManager.getGitHubRemotes()) : this._folderRepositoryManager.gitHubRepositories.map(repo => repo.remote);
		return remotes.map(remote => {
			return {
				iconPath: new vscode.ThemeIcon('repo'),
				label: `${remote.owner}/${remote.repositoryName}`,
				remote: {
					owner: remote.owner,
					repositoryName: remote.repositoryName,
				}
			};
		});
	}

	private async branchPicks(githubRepository: GitHubRepository, changeRepoMessage: string, isBase: boolean): Promise<(vscode.QuickPickItem & { remote?: RemoteInfo, branch?: string })[]> {
		let branches: (string | Ref)[];
		if (isBase) {
			// For the base, we only want to show branches from GitHub.
			branches = await githubRepository.listBranches(githubRepository.remote.owner, githubRepository.remote.repositoryName);
		} else {
			// For the compare, we only want to show local branches.
			branches = (await this._folderRepositoryManager.repository.getBranches({ remote: false })).filter(branch => branch.name);
		}
		// TODO: @alexr00 - Add sorting so that the most likely to be used branch (ex main or release if base) is at the top of the list.
		const branchPicks: (vscode.QuickPickItem & { remote?: RemoteInfo, branch?: string })[] = branches.map(branch => {
			const branchName = typeof branch === 'string' ? branch : branch.name!;
			const pick: (vscode.QuickPickItem & { remote: RemoteInfo, branch: string }) = {
				iconPath: new vscode.ThemeIcon('git-branch'),
				label: branchName,
				remote: {
					owner: githubRepository.remote.owner,
					repositoryName: githubRepository.remote.repositoryName
				},
				branch: branchName
			};
			return pick;
		});
		branchPicks.unshift({
			kind: vscode.QuickPickItemKind.Separator,
			label: `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`
		});
		branchPicks.unshift({
			iconPath: new vscode.ThemeIcon('repo'),
			label: changeRepoMessage
		});
		return branchPicks;
	}

	private async processRemoteAndBranchResult(githubRepository: GitHubRepository, result: { remote: RemoteInfo, branch: string }, isBase: boolean) {
		const [defaultBranch, viewerPermission] = await Promise.all([githubRepository.getDefaultBranch(), githubRepository.getViewerPermission()]);

		commands.setContext(contexts.CREATE_PR_PERMISSIONS, viewerPermission);
		let chooseResult: ChooseBaseRemoteAndBranchResult | ChooseCompareRemoteAndBranchResult;
		if (isBase) {
			const baseRemoteChanged = this.model.baseOwner !== result.remote.owner;
			const baseBranchChanged = baseRemoteChanged || this.model.baseBranch !== result.branch;
			this.model.baseOwner = result.remote.owner;
			this.model.baseBranch = result.branch;
			const compareBranch = await this._folderRepositoryManager.repository.getBranch(this.model.compareBranch);
			const [mergeConfiguration, titleAndDescription, mergeQueueMethodForBranch] = await Promise.all([
				this.getMergeConfiguration(result.remote.owner, result.remote.repositoryName),
				this.getTitleAndDescription(compareBranch, this.model.baseBranch),
				this._folderRepositoryManager.mergeQueueMethodForBranch(this.model.baseBranch, this.model.baseOwner, this.model.repositoryName)]);
			let autoMergeDefault = false;
			if (mergeConfiguration.viewerCanAutoMerge) {
				const defaultCreateOption = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'lastUsed' | 'create' | 'createDraft' | 'createAutoMerge'>(DEFAULT_CREATE_OPTION, 'lastUsed');
				const lastCreateMethod: { autoMerge: boolean, mergeMethod: MergeMethod | undefined, isDraft: boolean } | undefined = this._folderRepositoryManager.context.workspaceState.get<{ autoMerge: boolean, mergeMethod: MergeMethod, isDraft } | undefined>(PREVIOUS_CREATE_METHOD, undefined);
				autoMergeDefault = (defaultCreateOption === 'lastUsed' && lastCreateMethod?.autoMerge) || (defaultCreateOption === 'createAutoMerge');
			}

			chooseResult = {
				baseRemote: result.remote,
				baseBranch: result.branch,
				defaultBaseBranch: defaultBranch,
				defaultMergeMethod: getDefaultMergeMethod(mergeConfiguration.mergeMethodsAvailability),
				allowAutoMerge: mergeConfiguration.viewerCanAutoMerge,
				baseHasMergeQueue: !!mergeQueueMethodForBranch,
				mergeMethodsAvailability: mergeConfiguration.mergeMethodsAvailability,
				autoMergeDefault,
				defaultTitle: titleAndDescription.title,
				defaultDescription: titleAndDescription.description
			};
			if (baseRemoteChanged) {
				/* __GDPR__
				"pr.create.changedBaseRemote" : {}
				*/
				this._folderRepositoryManager.telemetry.sendTelemetryEvent('pr.create.changedBaseRemote');
			}
			if (baseBranchChanged) {
				/* __GDPR__
				"pr.create.changedBaseBranch" : {}
				*/
				this._folderRepositoryManager.telemetry.sendTelemetryEvent('pr.create.changedBaseBranch');
			}
		} else {
			await this.changeBranch(result.branch, false);
			chooseResult = {
				compareRemote: result.remote,
				compareBranch: result.branch,
				defaultCompareBranch: defaultBranch
			};
			/* __GDPR__
			"pr.create.changedCompare" : {}
			*/
			this._folderRepositoryManager.telemetry.sendTelemetryEvent('pr.create.changedCompare');
		}
		return chooseResult;
	}

	private async changeRemoteAndBranch(message: IRequestMessage<ChooseRemoteAndBranchArgs>, isBase: boolean): Promise<void> {
		this.cancelGenerateTitleAndDescription();
		const quickPick = vscode.window.createQuickPick<(vscode.QuickPickItem & { remote?: RemoteInfo, branch?: string })>();
		let githubRepository = this._folderRepositoryManager.findRepo(
			repo => message.args.currentRemote?.owner === repo.remote.owner && message.args.currentRemote.repositoryName === repo.remote.repositoryName,
		);

		const chooseDifferentRemote = vscode.l10n.t('Change Repository...');
		const remotePlaceholder = vscode.l10n.t('Choose a remote');
		const branchPlaceholder = isBase ? vscode.l10n.t('Choose a base branch') : vscode.l10n.t('Choose a branch to merge');
		const repositoryPlaceholder = isBase ? vscode.l10n.t('Choose a base repository') : vscode.l10n.t('Choose a repository to merge from');

		quickPick.placeholder = githubRepository ? branchPlaceholder : remotePlaceholder;
		quickPick.show();
		quickPick.busy = true;
		quickPick.items = githubRepository ? await this.branchPicks(githubRepository, chooseDifferentRemote, isBase) : await this.remotePicks(isBase);
		const activeItem = message.args.currentBranch ? quickPick.items.find(item => item.branch === message.args.currentBranch) : undefined;
		quickPick.activeItems = activeItem ? [activeItem] : [];
		quickPick.busy = false;
		const remoteAndBranch: Promise<{ remote: RemoteInfo, branch: string } | undefined> = new Promise((resolve) => {
			quickPick.onDidAccept(async () => {
				if (quickPick.selectedItems.length === 0) {
					return;
				}
				const selectedPick = quickPick.selectedItems[0];
				if (selectedPick.label === chooseDifferentRemote) {
					quickPick.busy = true;
					quickPick.items = await this.remotePicks(isBase);
					quickPick.busy = false;
					quickPick.placeholder = githubRepository ? repositoryPlaceholder : remotePlaceholder;
				} else if ((selectedPick.branch === undefined) && selectedPick.remote) {
					const selectedRemote = selectedPick as vscode.QuickPickItem & { remote: RemoteInfo };
					quickPick.busy = true;
					githubRepository = this._folderRepositoryManager.findRepo(repo => repo.remote.owner === selectedRemote.remote.owner && repo.remote.repositoryName === selectedRemote.remote.repositoryName)!;
					quickPick.items = await this.branchPicks(githubRepository, chooseDifferentRemote, isBase);
					quickPick.placeholder = branchPlaceholder;
					quickPick.busy = false;
				} else if (selectedPick.branch && selectedPick.remote) {
					const selectedBranch = selectedPick as vscode.QuickPickItem & { remote: RemoteInfo, branch: string };
					resolve({ remote: selectedBranch.remote, branch: selectedBranch.branch });
				}
			});
		});
		const hidePromise = new Promise<void>((resolve) => quickPick.onDidHide(() => resolve()));
		const result = await Promise.race([remoteAndBranch, hidePromise]);
		if (!result || !githubRepository) {
			quickPick.hide();
			quickPick.dispose();
			return;
		}

		quickPick.busy = true;
		const chooseResult = await this.processRemoteAndBranchResult(githubRepository, result, isBase);

		quickPick.hide();
		quickPick.dispose();
		return this._replyMessage(message, chooseResult);
	}

	private async findIssueContext(commits: string[]): Promise<{ content: string, reference: string }[] | undefined> {
		const issues: Promise<{ content: string, reference: string } | undefined>[] = [];
		for (const commit of commits) {
			const tryParse = parseIssueExpressionOutput(commit.match(ISSUE_OR_URL_EXPRESSION));
			if (tryParse) {
				const owner = tryParse.owner ?? this.model.baseOwner;
				const name = tryParse.name ?? this.model.repositoryName;
				issues.push(new Promise(resolve => {
					this._folderRepositoryManager.resolveIssue(owner, name, tryParse.issueNumber).then(issue => {
						if (issue) {
							resolve({ content: `${issue.title}\n${issue.body}`, reference: getIssueNumberLabelFromParsed(tryParse) });
						} else {
							resolve(undefined);
						}
					}).catch(() => resolve(undefined));
				}));
			}
		}
		if (issues.length) {
			return (await Promise.all(issues)).filter(issue => !!issue) as { content: string, reference: string }[];
		}
		return undefined;
	}

	private async getCommitsAndPatches(): Promise<{ commitMessages: string[], patches: { patch: string, fileUri: string, previousFileUri?: string }[] }> {
		let commitMessages: string[];
		let patches: ({ patch: string, fileUri: string, previousFileUri?: string } | undefined)[] | undefined;
		if (await this.model.getCompareHasUpstream()) {
			[commitMessages, patches] = await Promise.all([
				this.model.gitHubCommits().then(rawCommits => rawCommits.map(commit => commit.commit.message)),
				this.model.gitHubFiles().then(rawPatches => rawPatches?.map(file => {
					if (!file.patch) {
						return;
					}
					const fileUri = vscode.Uri.joinPath(this._folderRepositoryManager.repository.rootUri, file.filename).toString();
					const previousFileUri = file.previous_filename ? vscode.Uri.joinPath(this._folderRepositoryManager.repository.rootUri, file.previous_filename).toString() : undefined;
					return { patch: file.patch, fileUri, previousFileUri };
				}))]);
		} else {
			[commitMessages, patches] = await Promise.all([
				this.model.gitCommits().then(rawCommits => rawCommits.filter(commit => commit.parents.length === 1).map(commit => commit.message)),
				Promise.all((await this.model.gitFiles()).map(async (file) => {
					return {
						patch: await this._folderRepositoryManager.repository.diffBetween(this.model.baseBranch, this.model.compareBranch, file.uri.fsPath),
						fileUri: file.uri.toString(),
					};
				}))]);
		}
		const filteredPatches: { patch: string, fileUri: string, previousFileUri?: string }[] =
			patches?.filter<{ patch: string, fileUri: string, previousFileUri?: string }>((patch): patch is { patch: string, fileUri: string, previousFileUri?: string } => !!patch) ?? [];
		return { commitMessages, patches: filteredPatches };
	}

	private lastGeneratedTitleAndDescription: { title?: string, description?: string, providerTitle: string } | undefined;
	private async getTitleAndDescriptionFromProvider(token: vscode.CancellationToken, searchTerm?: string) {
		return CreatePullRequestViewProvider.withProgress(async () => {
			try {
				const { commitMessages, patches } = await this.getCommitsAndPatches();
				const issues = await this.findIssueContext(commitMessages);

				const provider = this._folderRepositoryManager.getTitleAndDescriptionProvider(searchTerm);
				const result = await provider?.provider.provideTitleAndDescription({ commitMessages, patches, issues }, token);

				if (provider) {
					this.lastGeneratedTitleAndDescription = { ...result, providerTitle: provider.title };
					/* __GDPR__
						"pr.generatedTitleAndDescription" : {
							"providerTitle" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
						}
					*/
					this.telemetry.sendTelemetryEvent('pr.generatedTitleAndDescription', { providerTitle: provider?.title });
				}
				return result;
			} catch (e) {
				Logger.error(`Error while generating title and description: ${e}`, CreatePullRequestViewProvider.ID);
				return undefined;
			}
		});
	}

	private generatingCancellationToken: vscode.CancellationTokenSource | undefined;
	private async generateTitleAndDescription(message: IRequestMessage<TitleAndDescriptionArgs>): Promise<void> {
		if (this.generatingCancellationToken) {
			this.generatingCancellationToken.cancel();
		}
		this.generatingCancellationToken = new vscode.CancellationTokenSource();


		const result = await Promise.race([this.getTitleAndDescriptionFromProvider(this.generatingCancellationToken.token, message.args.useCopilot ? 'Copilot' : undefined),
		new Promise<true>(resolve => this.generatingCancellationToken?.token.onCancellationRequested(() => resolve(true)))]);

		this.generatingCancellationToken = undefined;

		const generated: { title: string | undefined, description: string | undefined } = { title: undefined, description: undefined };
		if (result !== true) {
			generated.title = result?.title;
			generated.description = result?.description;
		}
		return this._replyMessage(message, { title: generated?.title, description: generated?.description });
	}

	private async cancelGenerateTitleAndDescription(): Promise<void> {
		if (this.generatingCancellationToken) {
			this.generatingCancellationToken.cancel();
		}
	}

	private async getPreReviewFromProvider(token: vscode.CancellationToken): Promise<PreReviewState | undefined> {
		const preReviewer = this._folderRepositoryManager.getAutoReviewer();
		if (!preReviewer) {
			return;
		}
		const { commitMessages, patches } = await this.getCommitsAndPatches();
		const result = await preReviewer.provider.provideReviewerComments({ repositoryRoot: this._folderRepositoryManager.repository.rootUri.fsPath, commitMessages, patches }, token);
		return (result && result.succeeded && result.files.length > 0) ? PreReviewState.ReviewedWithComments : PreReviewState.ReviewedWithoutComments;
	}

	public async review(): Promise<void> {
		this._postMessage({ command: 'reviewing', params: { reviewing: true } });
	}

	private reviewingCancellationToken: vscode.CancellationTokenSource | undefined;
	private async preReview(message: IRequestMessage<any>): Promise<void> {
		return CreatePullRequestViewProvider.withProgress(async () => {
			await commands.setContext('pr:preReviewing', true);

			if (this.reviewingCancellationToken) {
				this.reviewingCancellationToken.cancel();
			}
			this.reviewingCancellationToken = new vscode.CancellationTokenSource();

			const result = await Promise.race([this.getPreReviewFromProvider(this.reviewingCancellationToken.token),
			new Promise<void>(resolve => this.reviewingCancellationToken?.token.onCancellationRequested(() => resolve()))]);

			this.reviewingCancellationToken = undefined;
			await commands.setContext('pr:preReviewing', false);

			return this._replyMessage(message, result);
		});
	}

	private async cancelPreReview(): Promise<void> {
		if (this.reviewingCancellationToken) {
			this.reviewingCancellationToken.cancel();
		}
	}

	private async pushUpstream(compareOwner: string, compareRepositoryName: string, compareBranchName: string): Promise<{ compareUpstream: GitHubRemote, repo: GitHubRepository | undefined } | undefined> {
		let createdPushRemote: GitHubRemote | undefined;
		const pushRemote = this._folderRepositoryManager.repository.state.remotes.find(localRemote => {
			if (!localRemote.pushUrl) {
				return false;
			}
			const testRemote = new GitHubRemote(localRemote.name, localRemote.pushUrl, new Protocol(localRemote.pushUrl), GitHubServerType.GitHubDotCom);
			if ((testRemote.owner.toLowerCase() === compareOwner.toLowerCase()) && (testRemote.repositoryName.toLowerCase() === compareRepositoryName.toLowerCase())) {
				createdPushRemote = testRemote;
				return true;
			}
			return false;
		});

		if (pushRemote && createdPushRemote) {
			Logger.appendLine(`Found push remote ${pushRemote.name} for ${compareOwner}/${compareRepositoryName} and branch ${compareBranchName}`, CreatePullRequestViewProvider.ID);
			const actualPushRemote = await this._folderRepositoryManager.publishBranch(createdPushRemote, compareBranchName);
			if (!actualPushRemote) {
				return undefined;
			}
			return { compareUpstream: actualPushRemote, repo: this._folderRepositoryManager.findRepo(byRemoteName(actualPushRemote.remoteName)) };
		}
	}

	private checkGeneratedTitleAndDescription(title: string, description: string) {
		if (!this.lastGeneratedTitleAndDescription) {
			return;
		}
		const usedGeneratedTitle: boolean = !!this.lastGeneratedTitleAndDescription.title && ((this.lastGeneratedTitleAndDescription.title === title) || this.lastGeneratedTitleAndDescription.title?.includes(title) || title?.includes(this.lastGeneratedTitleAndDescription.title));
		const usedGeneratedDescription: boolean = !!this.lastGeneratedTitleAndDescription.description && ((this.lastGeneratedTitleAndDescription.description === description) || this.lastGeneratedTitleAndDescription.description?.includes(description) || description?.includes(this.lastGeneratedTitleAndDescription.description));
		/* __GDPR__
			"pr.usedGeneratedTitleAndDescription" : {
				"providerTitle" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"usedGeneratedTitle" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"usedGeneratedDescription" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryEvent('pr.usedGeneratedTitleAndDescription', { providerTitle: this.lastGeneratedTitleAndDescription.providerTitle, usedGeneratedTitle: usedGeneratedTitle.toString(), usedGeneratedDescription: usedGeneratedDescription.toString() });
	}

	/**
	 *
	 * @returns true if the PR should be created immediately after
	 */
	private async checkForChanges(): Promise<boolean> {
		if (await this.model.filesHaveChanges()) {
			const apply = vscode.l10n.t('Commit');
			const deleteChanges = vscode.l10n.t('Delete my changes');
			const result = await vscode.window.showWarningMessage(vscode.l10n.t('You have made changes to the files in this pull request. Do you want to commit these changes to the pull request before creating it?'), { modal: true }, apply, deleteChanges);
			if (result === apply) {
				const commitMessage = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Commit message for your changes') });
				if (commitMessage) {
					return this.model.applyChanges(commitMessage);
				}
			} else if (result !== deleteChanges) {
				return false;
			}
		}
		return true;
	}

	protected async create(message: IRequestMessage<CreatePullRequestNew>): Promise<void> {
		Logger.debug(`Creating pull request with args ${JSON.stringify(message.args)}`, CreatePullRequestViewProvider.ID);

		if (!(await this.checkForChanges())) {
			Logger.debug('Not continuing past checking for file changes.', CreatePullRequestViewProvider.ID);
			await this._replyMessage(message, {});
			return;
		}

		// Save create method
		const createMethod: { autoMerge: boolean, mergeMethod: MergeMethod | undefined, isDraft: boolean } = { autoMerge: message.args.autoMerge, mergeMethod: message.args.autoMergeMethod, isDraft: message.args.draft };
		this._folderRepositoryManager.context.workspaceState.update(PREVIOUS_CREATE_METHOD, createMethod);

		CreatePullRequestViewProvider.withProgress(() => {
			return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async progress => {
				commands.setContext(contexts.CREATING, true);
				let totalIncrement = 0;
				progress.report({ message: vscode.l10n.t('Checking for upstream branch'), increment: totalIncrement });
				let createdPR: PullRequestModel | undefined = undefined;
				try {
					const compareOwner = message.args.compareOwner;
					const compareRepositoryName = message.args.compareRepo;
					const compareBranchName = message.args.compareBranch;
					const compareGithubRemoteName = `${compareOwner}/${compareRepositoryName}`;
					const compareBranch = await this._folderRepositoryManager.repository.getBranch(compareBranchName);
					let headRepo = compareBranch.upstream ? this._folderRepositoryManager.findRepo((githubRepo) => {
						return (githubRepo.remote.owner === compareOwner) && (githubRepo.remote.repositoryName === compareRepositoryName);
					}) : undefined;
					let existingCompareUpstream = headRepo?.remote;

					if (!existingCompareUpstream
						|| (existingCompareUpstream.owner !== compareOwner)
						|| (existingCompareUpstream.repositoryName !== compareRepositoryName)) {

						// We assume this happens only when the compare branch is based on the current branch.
						const alwaysPublish = vscode.l10n.t('Always Publish Branch');
						const publish = vscode.l10n.t('Publish Branch');
						const pushBranchSetting =
							vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get(PUSH_BRANCH) === 'always';
						const messageResult = !pushBranchSetting ? await vscode.window.showInformationMessage(
							vscode.l10n.t('There is no remote branch on {0}/{1} for \'{2}\'.\n\nDo you want to publish it and then create the pull request?', compareOwner, compareRepositoryName, compareBranchName),
							{ modal: true },
							publish,
							alwaysPublish)
							: publish;
						if (messageResult === alwaysPublish) {
							await vscode.workspace
								.getConfiguration(PR_SETTINGS_NAMESPACE)
								.update(PUSH_BRANCH, 'always', vscode.ConfigurationTarget.Global);
						}
						if ((messageResult === alwaysPublish) || (messageResult === publish)) {
							progress.report({ message: vscode.l10n.t('Pushing branch'), increment: 10 });
							totalIncrement += 10;

							const pushResult = await this.pushUpstream(compareOwner, compareRepositoryName, compareBranchName);
							if (pushResult) {
								existingCompareUpstream = pushResult.compareUpstream;
								headRepo = pushResult.repo;
							} else {
								this._throwError(message, vscode.l10n.t('The current repository does not have a push remote for {0}', compareGithubRemoteName));
							}
						}
					}
					if (!existingCompareUpstream) {
						this._throwError(message, vscode.l10n.t('No remote branch on {0}/{1} for the merge branch.', compareOwner, compareRepositoryName));
						progress.report({ message: vscode.l10n.t('Pull request cancelled'), increment: 100 - totalIncrement });
						return;
					}

					if (!headRepo) {
						throw new Error(vscode.l10n.t('Unable to find GitHub repository matching \'{0}\'. You can add \'{0}\' to the setting "githubPullRequests.remotes" to ensure \'{0}\' is found.', existingCompareUpstream.remoteName));
					}

					progress.report({ message: vscode.l10n.t('Creating pull request'), increment: 70 - totalIncrement });
					totalIncrement += 70 - totalIncrement;
					const head = `${headRepo.remote.owner}:${compareBranchName}`;
					this.checkGeneratedTitleAndDescription(message.args.title, message.args.body);
					createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head });

					// Create was cancelled
					if (!createdPR) {
						this._throwError(message, vscode.l10n.t('There must be a difference in commits to create a pull request.'));
					} else {
						await this.postCreate(message, createdPR);
					}
				} catch (e) {
					if (!createdPR) {
						let errorMessage: string = e.message;
						if (errorMessage.startsWith('GraphQL error: ')) {
							errorMessage = errorMessage.substring('GraphQL error: '.length);
						}
						this._throwError(message, errorMessage);
					} else {
						if ((e as Error).message === 'GraphQL error: ["Pull request Pull request is in unstable status"]') {
							// This error can happen if the PR isn't fully created by the time we try to set properties on it. Try again.
							await this.postCreate(message, createdPR);
						}
						// All of these errors occur after the PR is created, so the error is not critical.
						vscode.window.showErrorMessage(vscode.l10n.t('There was an error creating the pull request: {0}', (e as Error).message));
					}
				} finally {
					commands.setContext(contexts.CREATING, false);

					let completeMessage: string;
					if (createdPR) {
						this._onDone.fire(createdPR);
						completeMessage = vscode.l10n.t('Pull request created');
					} else {
						await this._replyMessage(message, {});
						completeMessage = vscode.l10n.t('Unable to create pull request');
					}
					progress.report({ message: completeMessage, increment: 100 - totalIncrement });
				}
			});
		});
	}

	private async changeBranch(newBranch: string, isBase: boolean): Promise<{ title: string, description: string }> {
		let compareBranch: Branch | undefined;
		if (isBase) {
			this.model.baseBranch = newBranch;
		} else {
			try {
				compareBranch = await this._folderRepositoryManager.repository.getBranch(newBranch);
				await this.model.setCompareBranch(newBranch);
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Branch does not exist locally.'));
			}
		}

		compareBranch = compareBranch ?? await this._folderRepositoryManager.repository.getBranch(this.model.compareBranch);
		return this.getTitleAndDescription(compareBranch, this.model.baseBranch);
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'pr.changeBaseRemoteAndBranch':
				return this.changeRemoteAndBranch(message, true);

			case 'pr.changeCompareRemoteAndBranch':
				return this.changeRemoteAndBranch(message, false);

			case 'pr.generateTitleAndDescription':
				return this.generateTitleAndDescription(message);

			case 'pr.cancelGenerateTitleAndDescription':
				return this.cancelGenerateTitleAndDescription();

			case 'pr.preReview':
				return this.preReview(message);

			case 'pr.cancelPreReview':
				return this.cancelPreReview();

			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
	}
}