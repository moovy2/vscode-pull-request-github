/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import TelemetryReporter from '@vscode/extension-telemetry';
import * as vscode from 'vscode';
import { LiveShare } from 'vsls/vscode.js';
import { PostCommitCommandsProvider, Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { registerCommands } from './commands';
import { commands } from './common/executeCommands';
import Logger from './common/logger';
import * as PersistentState from './common/persistentState';
import { parseRepositoryRemotes } from './common/remote';
import { Resource } from './common/resources';
import { BRANCH_PUBLISH, EXPERIMENTAL_CHAT, FILE_LIST_LAYOUT, GIT, OPEN_DIFF_ON_CLICK, PR_SETTINGS_NAMESPACE, SHOW_INLINE_OPEN_FILE_ACTION } from './common/settingKeys';
import { initBasedOnSettingChange } from './common/settingsUtils';
import { TemporaryState } from './common/temporaryState';
import { Schemes } from './common/uri';
import { EXTENSION_ID, FOCUS_REVIEW_MODE } from './constants';
import { createExperimentationService, ExperimentationTelemetry } from './experimentationService';
import { CopilotRemoteAgentManager } from './github/copilotRemoteAgent';
import { CredentialStore } from './github/credentials';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { RepositoriesManager } from './github/repositoriesManager';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { GitHubContactServiceProvider } from './gitProviders/GitHubContactServiceProvider';
import { GitLensIntegration } from './integrations/gitlens/gitlensImpl';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';
import { ChatParticipant, ChatParticipantState } from './lm/participants';
import { registerTools } from './lm/tools/tools';
import { migrate } from './migrations';
import { NotificationsFeatureRegister } from './notifications/notificationsFeatureRegistar';
import { ThemeWatcher } from './themeWatcher';
import { UriHandler } from './uriHandler';
import { CommentDecorationProvider } from './view/commentDecorationProvider';
import { CompareChanges } from './view/compareChangesTreeDataProvider';
import { CreatePullRequestHelper } from './view/createPullRequestHelper';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { GitHubCommitFileSystemProvider } from './view/githubFileContentProvider';
import { getInMemPRFileSystemProvider } from './view/inMemPRContentProvider';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { PRNotificationDecorationProvider } from './view/prNotificationDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager, ShowPullRequest } from './view/reviewManager';
import { ReviewsManager } from './view/reviewsManager';
import { SessionLogViewManager } from './view/sessionLogView';
import { TreeDecorationProviders } from './view/treeDecorationProviders';
import { WebviewViewCoordinator } from './view/webviewViewCoordinator';

const ingestionKey = '0c6ae279ed8443289764825290e4f9e2-1a736e7c-1324-4338-be46-fc2a58ae4d14-7255';

let telemetry: ExperimentationTelemetry;

const ACTIVATION = 'Activation';

async function init(
	context: vscode.ExtensionContext,
	git: GitApiImpl,
	credentialStore: CredentialStore,
	repositories: Repository[],
	tree: PullRequestsTreeDataProvider,
	liveshareApiPromise: Promise<LiveShare | undefined>,
	showPRController: ShowPullRequest,
	reposManager: RepositoriesManager,
	createPrHelper: CreatePullRequestHelper,
	copilotRemoteAgentManager: CopilotRemoteAgentManager,
	themeWatcher: ThemeWatcher
): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.', ACTIVATION);

	context.subscriptions.push(credentialStore.onDidChangeSessions(async e => {
		if (e.provider.id === 'github') {
			await reposManager.clearCredentialCache();
			if (reviewsManager) {
				reviewsManager.reviewManagers.forEach(reviewManager => reviewManager.updateState(true));
			}
		}
	}));

	context.subscriptions.push(
		git.onDidPublish(async e => {
			// Only notify on branch publish events
			if (!e.branch) {
				return;
			}

			if (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'ask' | 'never' | undefined>(BRANCH_PUBLISH) !== 'ask') {
				return;
			}

			const reviewManager = reviewsManager.reviewManagers.find(
				manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString(),
			);
			if (reviewManager?.isCreatingPullRequest) {
				return;
			}

			const folderManager = reposManager.folderManagers.find(
				manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString());

			if (!folderManager || folderManager.gitHubRepositories.length === 0) {
				return;
			}

			const defaults = await folderManager.getPullRequestDefaults();
			if (defaults.base === e.branch) {
				return;
			}

			const create = vscode.l10n.t('Create Pull Request...');
			const dontShowAgain = vscode.l10n.t('Don\'t Show Again');
			const result = await vscode.window.showInformationMessage(
				vscode.l10n.t('Would you like to create a Pull Request for branch \'{0}\'?', e.branch),
				create,
				dontShowAgain,
			);
			if (result === create) {
				reviewManager?.createPullRequest(e.branch);
			} else if (result === dontShowAgain) {
				await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(BRANCH_PUBLISH, 'never', vscode.ConfigurationTarget.Global);
			}
		}),
	);

	// Sort the repositories to match folders in a multiroot workspace (if possible).
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		repositories = repositories.sort((a, b) => {
			let indexA = workspaceFolders.length;
			let indexB = workspaceFolders.length;
			for (let i = 0; i < workspaceFolders.length; i++) {
				if (workspaceFolders[i].uri.toString() === a.rootUri.toString()) {
					indexA = i;
				} else if (workspaceFolders[i].uri.toString() === b.rootUri.toString()) {
					indexB = i;
				}
				if (indexA !== workspaceFolders.length && indexB !== workspaceFolders.length) {
					break;
				}
			}
			return indexA - indexB;
		});
	}

	liveshareApiPromise.then(api => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});

	const changesTree = new PullRequestChangesTreeDataProvider(git, reposManager);
	context.subscriptions.push(changesTree);

	const activePrViewCoordinator = new WebviewViewCoordinator(context);
	context.subscriptions.push(activePrViewCoordinator);

	let reviewManagerIndex = 0;
	const reviewManagers = reposManager.folderManagers.map(
		folderManager => new ReviewManager(reviewManagerIndex++, context, folderManager.repository, folderManager, telemetry, changesTree, tree, showPRController, activePrViewCoordinator, createPrHelper, git),
	);
	const treeDecorationProviders = new TreeDecorationProviders(reposManager);
	context.subscriptions.push(treeDecorationProviders);
	treeDecorationProviders.registerProviders([new FileTypeDecorationProvider(), new CommentDecorationProvider(reposManager)]);

	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, credentialStore, git, copilotRemoteAgentManager);
	context.subscriptions.push(reviewsManager);

	git.onDidChangeState(() => {
		Logger.appendLine(`Git initialization state changed: state=${git.state}`, ACTIVATION);
		reviewsManager.reviewManagers.forEach(reviewManager => reviewManager.updateState(true));
	});

	git.onDidOpenRepository(repo => {
		function addRepo() {
			// Make sure we don't already have a folder manager for this repo.
			const existing = reposManager.folderManagers.find(manager => manager.repository.rootUri.toString() === repo.rootUri.toString());
			if (existing) {
				Logger.appendLine(`Repo ${repo.rootUri} has already been setup.`, ACTIVATION);
				return;
			}
			const newFolderManager = new FolderRepositoryManager(reposManager.folderManagers.length, context, repo, telemetry, git, credentialStore, createPrHelper, themeWatcher);
			reposManager.insertFolderManager(newFolderManager);
			const newReviewManager = new ReviewManager(
				reviewManagerIndex++,
				context,
				newFolderManager.repository,
				newFolderManager,
				telemetry,
				changesTree,
				tree,
				showPRController,
				activePrViewCoordinator,
				createPrHelper,
				git
			);
			reviewsManager.addReviewManager(newReviewManager);
		}
		addRepo();
		tree.notificationProvider.refreshOrLaunchPolling();
		const disposable = repo.state.onDidChange(() => {
			Logger.appendLine(`Repo state for ${repo.rootUri} changed.`, ACTIVATION);
			addRepo();
			disposable.dispose();
		});
	});

	git.onDidCloseRepository(repo => {
		reposManager.removeRepo(repo);
		reviewsManager.removeReviewManager(repo);
		tree.notificationProvider.refreshOrLaunchPolling();
	});

	tree.initialize(reviewsManager.reviewManagers.map(manager => manager.reviewModel), credentialStore);

	context.subscriptions.push(new PRNotificationDecorationProvider(tree.notificationProvider));

	registerCommands(context, reposManager, reviewsManager, telemetry, tree, copilotRemoteAgentManager);

	const layout = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
	await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');

	const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewsManager, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	const notificationsFeatures = new NotificationsFeatureRegister(credentialStore, reposManager, telemetry, context);
	context.subscriptions.push(notificationsFeatures);

	context.subscriptions.push(new GitLensIntegration());

	const sessionLogViewManager = new SessionLogViewManager(credentialStore, context, reposManager, telemetry, copilotRemoteAgentManager);
	context.subscriptions.push(sessionLogViewManager);

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);

	registerPostCommitCommandsProvider(reposManager, git);

	initChat(context, credentialStore, reposManager, copilotRemoteAgentManager, telemetry);
	context.subscriptions.push(vscode.window.registerUriHandler(new UriHandler(reposManager, telemetry, context)));

	// Make sure any compare changes tabs, which come from the create flow, are closed.
	CompareChanges.closeTabs();
	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

function initChat(context: vscode.ExtensionContext, credentialStore: CredentialStore, reposManager: RepositoriesManager, copilotRemoteManager: CopilotRemoteAgentManager, telemetry: ExperimentationTelemetry) {
	const createParticipant = () => {
		const chatParticipantState = new ChatParticipantState();
		context.subscriptions.push(new ChatParticipant(context, chatParticipantState));
		registerTools(context, credentialStore, reposManager, chatParticipantState, copilotRemoteManager, telemetry);
	};

	const chatEnabled = () => vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(EXPERIMENTAL_CHAT, false);
	if (chatEnabled()) {
		createParticipant();
	} else {
		initBasedOnSettingChange(PR_SETTINGS_NAMESPACE, EXPERIMENTAL_CHAT, chatEnabled, createParticipant, context.subscriptions);
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	Logger.appendLine(`Extension version: ${vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version}`, 'Activation');
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	if (EXTENSION_ID === 'GitHub.vscode-pull-request-github-insiders') {
		const stable = vscode.extensions.getExtension('github.vscode-pull-request-github');
		if (stable !== undefined) {
			throw new Error(
				'GitHub Pull Requests and Issues Nightly cannot be used while GitHub Pull Requests and Issues is also installed. Please ensure that only one version of the extension is installed.',
			);
		}
	}

	const showPRController = new ShowPullRequest();
	vscode.commands.registerCommand('github.api.preloadPullRequest', async (shouldShow: boolean) => {
		await vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
		await commands.focusView('github:activePullRequest:welcome');
		showPRController.shouldShow = shouldShow;
	});
	await setGitSettingContexts(context);

	// initialize resources
	Resource.initialize(context);
	Logger.debug('Creating API implementation.', 'Activation');

	telemetry = new ExperimentationTelemetry(new TelemetryReporter(ingestionKey));
	context.subscriptions.push(telemetry);

	return await deferredActivate(context, showPRController);
}

async function setGitSettingContexts(context: vscode.ExtensionContext) {
	// We set contexts instead of using the config directly in package.json because the git extension might not actually be available.
	const settings: [string, () => void][] = [
		['openDiffOnClick', () => vscode.workspace.getConfiguration(GIT, null).get(OPEN_DIFF_ON_CLICK, true)],
		['showInlineOpenFileAction', () => vscode.workspace.getConfiguration(GIT, null).get(SHOW_INLINE_OPEN_FILE_ACTION, true)]
	];
	for (const [contextName, setting] of settings) {
		commands.setContext(contextName, setting());
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${GIT}.${contextName}`)) {
				commands.setContext(contextName, setting());
			}
		}));
	}
}

async function doRegisterBuiltinGitProvider(context: vscode.ExtensionContext, credentialStore: CredentialStore, apiImpl: GitApiImpl): Promise<boolean> {
	const builtInGitProvider = await registerBuiltinGitProvider(credentialStore, apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
		return true;
	}
	return false;
}

function registerPostCommitCommandsProvider(reposManager: RepositoriesManager, git: GitApiImpl) {
	const componentId = 'GitPostCommitCommands';
	class Provider implements PostCommitCommandsProvider {

		getCommands(repository: Repository) {
			Logger.debug(`Looking for remote. Comparing ${repository.state.remotes.length} local repo remotes with ${reposManager.folderManagers.reduce((prev, curr) => prev + curr.gitHubRepositories.length, 0)} GitHub repositories.`, componentId);
			const repoRemotes = parseRepositoryRemotes(repository);

			const found = reposManager.folderManagers.find(folderManager => folderManager.findRepo(githubRepo => {
				return !!repoRemotes.find(remote => {
					return remote.equals(githubRepo.remote);
				});
			}));
			Logger.debug(`Found ${found ? 'a repo' : 'no repos'} when getting post commit commands.`, componentId);
			return found ? [{
				command: 'pr.pushAndCreate',
				title: vscode.l10n.t('{0} Commit & Create Pull Request', '$(git-pull-request-create)'),
				tooltip: vscode.l10n.t('Commit & Create Pull Request')
			}] : [];
		}
	}

	function hasGitHubRepos(): boolean {
		return reposManager.folderManagers.some(folderManager => folderManager.gitHubRepositories.length > 0);
	}
	function tryRegister(): boolean {
		Logger.debug('Trying to register post commit commands.', 'GitPostCommitCommands');
		if (hasGitHubRepos()) {
			Logger.debug('GitHub remote(s) found, registering post commit commands.', componentId);
			git.registerPostCommitCommandsProvider(new Provider());
			return true;
		}
		return false;
	}

	if (!tryRegister()) {
		const reposDisposable = reposManager.onDidLoadAnyRepositories(() => {
			if (tryRegister()) {
				reposDisposable.dispose();
			}
		});
	}
}

async function deferredActivateRegisterBuiltInGitProvider(context: vscode.ExtensionContext, apiImpl: GitApiImpl, credentialStore: CredentialStore) {
	Logger.debug('Registering built in git provider.', 'Activation');
	if (!(await doRegisterBuiltinGitProvider(context, credentialStore, apiImpl))) {
		const extensionsChangedDisposable = vscode.extensions.onDidChange(async () => {
			if (await doRegisterBuiltinGitProvider(context, credentialStore, apiImpl)) {
				extensionsChangedDisposable.dispose();
			}
		});
		context.subscriptions.push(extensionsChangedDisposable);
	}
}

async function deferredActivate(context: vscode.ExtensionContext, showPRController: ShowPullRequest) {
	Logger.debug('Initializing state.', 'Activation');
	PersistentState.init(context);
	await migrate(context);
	TemporaryState.init(context);
	Logger.debug('Creating credential store.', 'Activation');
	const credentialStore = new CredentialStore(telemetry, context);
	context.subscriptions.push(credentialStore);
	const experimentationService = await createExperimentationService(context, telemetry);
	await experimentationService.initializePromise;
	await experimentationService.isCachedFlightEnabled('githubaa');
	const showBadge = (vscode.env.appHost === 'desktop');
	await credentialStore.create(showBadge ? undefined : { silent: true });

	const reposManager = new RepositoriesManager(credentialStore, telemetry);
	context.subscriptions.push(reposManager);
	// API
	const apiImpl = new GitApiImpl(reposManager);
	context.subscriptions.push(apiImpl);

	deferredActivateRegisterBuiltInGitProvider(context, apiImpl, credentialStore);

	Logger.debug('Registering live share git provider.', 'Activation');
	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.debug('Creating tree view.', 'Activation');

	const copilotRemoteAgentManager = new CopilotRemoteAgentManager(credentialStore, reposManager, telemetry);
	context.subscriptions.push(copilotRemoteAgentManager);
	if (vscode.chat?.registerChatSessionItemProvider) {
		const provider = new class implements vscode.ChatSessionContentProvider, vscode.ChatSessionItemProvider {
			label = vscode.l10n.t('GitHub Copilot Coding Agent');
			provideChatSessionItems = async (token) => {
				return await copilotRemoteAgentManager.provideChatSessions(token);
			};
			provideChatSessionContent = async (id, token) => {
				return await copilotRemoteAgentManager.provideChatSessionContent(id, token);
			};
			onDidChangeChatSessionItems = copilotRemoteAgentManager.onDidChangeChatSessions;
		}();

		context.subscriptions.push(vscode.chat?.registerChatSessionItemProvider(
			'copilot-swe-agent',
			provider
		));

		context.subscriptions.push(vscode.chat?.registerChatSessionContentProvider(
			'copilot-swe-agent',
			provider
		));
	}

	const prTree = new PullRequestsTreeDataProvider(telemetry, context, reposManager, copilotRemoteAgentManager);
	context.subscriptions.push(prTree);
	context.subscriptions.push(credentialStore.onDidGetSession(() => prTree.refresh(undefined, true)));
	Logger.appendLine('Looking for git repository', ACTIVATION);
	const repositories = apiImpl.repositories;
	Logger.appendLine(`Found ${repositories.length} repositories during activation`, ACTIVATION);
	const createPrHelper = new CreatePullRequestHelper();
	context.subscriptions.push(createPrHelper);

	const themeWatcher = new ThemeWatcher();
	context.subscriptions.push(themeWatcher);

	let folderManagerIndex = 0;
	const folderManagers = repositories.map(
		repository => new FolderRepositoryManager(folderManagerIndex++, context, repository, telemetry, apiImpl, credentialStore, createPrHelper, themeWatcher),
	);
	context.subscriptions.push(...folderManagers);
	for (const folderManager of folderManagers) {
		reposManager.insertFolderManager(folderManager);
	}

	const inMemPRFileSystemProvider = getInMemPRFileSystemProvider({ reposManager, gitAPI: apiImpl, credentialStore })!;
	const readOnlyMessage = new vscode.MarkdownString(vscode.l10n.t('Cannot edit this pull request file. [Check out](command:pr.checkoutFromReadonlyFile) this pull request to edit.'));
	readOnlyMessage.isTrusted = { enabledCommands: ['pr.checkoutFromReadonlyFile'] };
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(Schemes.Pr, inMemPRFileSystemProvider, { isReadonly: readOnlyMessage }));
	const githubFilesystemProvider = new GitHubCommitFileSystemProvider(reposManager, apiImpl, credentialStore);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(Schemes.GitHubCommit, githubFilesystemProvider, { isReadonly: new vscode.MarkdownString(vscode.l10n.t('GitHub commits cannot be edited')) }));

	await init(context, apiImpl, credentialStore, repositories, prTree, liveshareApiPromise, showPRController, reposManager, createPrHelper, copilotRemoteAgentManager, themeWatcher);
	return apiImpl;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
