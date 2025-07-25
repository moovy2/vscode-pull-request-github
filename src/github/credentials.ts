/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, InMemoryCache } from 'apollo-boost';
import { setContext } from 'apollo-link-context';
import { createHttpLink } from 'apollo-link-http';
import fetch from 'cross-fetch';
import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import * as PersistentState from '../common/persistentState';
import { GITHUB_ENTERPRISE, URI } from '../common/settingKeys';
import { initBasedOnSettingChange } from '../common/settingsUtils';
import { ITelemetry } from '../common/telemetry';
import { agent } from '../env/node/net';
import { IAccount } from './interface';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from './loggingOctokit';
import { convertRESTUserToAccount, getEnterpriseUri, hasEnterpriseUri, isEnterprise } from './utils';

const TRY_AGAIN = vscode.l10n.t('Try again?');
const CANCEL = vscode.l10n.t('Cancel');
const SIGNIN_COMMAND = vscode.l10n.t('Sign In');
const IGNORE_COMMAND = vscode.l10n.t('Don\'t Show Again');

const PROMPT_FOR_SIGN_IN_SCOPE = vscode.l10n.t('prompt for sign in');
const PROMPT_FOR_SIGN_IN_STORAGE_KEY = 'login';

// If the scopes are changed, make sure to notify all interested parties to make sure this won't cause problems.
const SCOPES_OLDEST = ['read:user', 'user:email', 'repo'];
const SCOPES_OLD = ['read:user', 'user:email', 'repo', 'workflow'];
const SCOPES_WITH_ADDITIONAL = ['read:user', 'user:email', 'repo', 'workflow', 'project', 'read:org'];

const LAST_USED_SCOPES_GITHUB_KEY = 'githubPullRequest.lastUsedScopes';
const LAST_USED_SCOPES_ENTERPRISE_KEY = 'githubPullRequest.lastUsedScopesEnterprise';

export interface GitHub {
	octokit: LoggingOctokit;
	graphql: LoggingApolloClient;
	currentUser?: Promise<IAccount>;
	isEmu?: Promise<boolean>;
}

interface AuthResult {
	canceled: boolean;
}

export class CredentialStore extends Disposable {
	private static readonly ID = 'Authentication';
	private _githubAPI: GitHub | undefined;
	private _sessionId: string | undefined;
	private _githubEnterpriseAPI: GitHub | undefined;
	private _enterpriseSessionId: string | undefined;
	private _isInitialized: boolean = false;
	private _onDidInitialize: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidInitialize: vscode.Event<void> = this._onDidInitialize.event;
	private _scopes: string[] = SCOPES_OLD;
	private _scopesEnterprise: string[] = SCOPES_OLD;
	private _isSamling: boolean = false;

	private _onDidChangeSessions: vscode.EventEmitter<vscode.AuthenticationSessionsChangeEvent> = new vscode.EventEmitter();
	public readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private _onDidGetSession: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidGetSession = this._onDidGetSession.event;

	private _onDidUpgradeSession: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidUpgradeSession = this._onDidUpgradeSession.event;

	constructor(private readonly _telemetry: ITelemetry, private readonly context: vscode.ExtensionContext) {
		super();
		this.setScopesFromState();

		this._register(vscode.authentication.onDidChangeSessions((e) => this.handlOnDidChangeSessions(e)));
	}

	private async handlOnDidChangeSessions(e: vscode.AuthenticationSessionsChangeEvent) {
		const currentProvider = (e.provider.id === AuthProvider.github && this._githubAPI) ? AuthProvider.github : ((e.provider.id === AuthProvider.githubEnterprise && this._githubEnterpriseAPI) ? AuthProvider.githubEnterprise : undefined);
		if ((this._githubAPI || this._githubEnterpriseAPI) && !currentProvider) {
			return;
		}
		if (currentProvider) {
			const newSession = await this.getSession(currentProvider, { silent: true }, currentProvider === AuthProvider.github ? this._scopes : this._scopesEnterprise, true);
			if (newSession.session?.id === this._sessionId) {
				return;
			}
			if (currentProvider === AuthProvider.github) {
				this._githubAPI = undefined;
				this._sessionId = undefined;
			} else {
				this._githubEnterpriseAPI = undefined;
				this._enterpriseSessionId = undefined;
			}
		}
		const promises: Promise<any>[] = [];
		if (!this.isAuthenticated(AuthProvider.github)) {
			promises.push(this.initialize(AuthProvider.github));
		}

		if (!this.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			promises.push(this.initialize(AuthProvider.githubEnterprise));
		}

		await Promise.all(promises);
		if (this.isAnyAuthenticated()) {
			this._onDidGetSession.fire();
		} else if (!this._isSamling) {
			this._onDidChangeSessions.fire(e);
		}
	}

	private allScopesIncluded(actualScopes: string[], requiredScopes: string[]) {
		return requiredScopes.every(scope => actualScopes.includes(scope));
	}

	private setScopesFromState() {
		this._scopes = this.context.globalState.get(LAST_USED_SCOPES_GITHUB_KEY, SCOPES_OLD);
		this._scopesEnterprise = this.context.globalState.get(LAST_USED_SCOPES_ENTERPRISE_KEY, SCOPES_OLD);
	}

	private async saveScopesInState() {
		await this.context.globalState.update(LAST_USED_SCOPES_GITHUB_KEY, this._scopes);
		await this.context.globalState.update(LAST_USED_SCOPES_ENTERPRISE_KEY, this._scopesEnterprise);
	}
	private async initialize(authProviderId: AuthProvider, getAuthSessionOptions: vscode.AuthenticationGetSessionOptions = {}, scopes: string[] = (!isEnterprise(authProviderId) ? this._scopes : this._scopesEnterprise), requireScopes?: boolean): Promise<AuthResult> {
		Logger.debug(`Initializing GitHub${getGitHubSuffix(authProviderId)} authentication provider.`, 'Authentication');
		if (isEnterprise(authProviderId)) {
			if (!hasEnterpriseUri()) {
				Logger.debug(`GitHub Enterprise provider selected without URI.`, 'Authentication');
				return { canceled: false };
			}
		}

		if (getAuthSessionOptions.createIfNone === undefined && getAuthSessionOptions.forceNewSession === undefined) {
			getAuthSessionOptions.createIfNone = false;
		}

		let session: vscode.AuthenticationSession | undefined = undefined;
		let isNew: boolean = false;
		let usedScopes: string[] | undefined = SCOPES_OLD;
		const oldScopes = this._scopes;
		const oldEnterpriseScopes = this._scopesEnterprise;
		const authResult: AuthResult = { canceled: false };
		try {
			// Set scopes before getting the session to prevent new session events from using the old scopes.
			if (!isEnterprise(authProviderId)) {
				this._scopes = scopes;
			} else {
				this._scopesEnterprise = scopes;
			}
			const result = await this.getSession(authProviderId, getAuthSessionOptions, scopes, !!requireScopes);
			usedScopes = result.scopes;
			session = result.session;
			isNew = result.isNew;
		} catch (e) {
			this._scopes = oldScopes;
			this._scopesEnterprise = oldEnterpriseScopes;
			const userCanceld = (e.message === 'User did not consent to login.');
			if (userCanceld) {
				authResult.canceled = true;
			}
			if (getAuthSessionOptions.forceNewSession && userCanceld) {
				// There are cases where a forced login may not be 100% needed, so just continue as usual if
				// the user didn't consent to the login prompt.
			} else {
				throw e;
			}
		}

		if (session) {
			if (!isEnterprise(authProviderId)) {
				this._sessionId = session.id;
			} else {
				this._enterpriseSessionId = session.id;
			}
			let github: GitHub | undefined;
			try {
				github = await this.createHub(session.accessToken, authProviderId);
			} catch (e) {
				if ((e.message === 'Bad credentials') && !getAuthSessionOptions.forceNewSession) {
					Logger.debug(`Creating hub failed ${e.message}`, CredentialStore.ID);
					getAuthSessionOptions.forceNewSession = true;
					getAuthSessionOptions.silent = false;
					return this.initialize(authProviderId, getAuthSessionOptions, scopes, requireScopes);
				} else {
					// console.log because we need to see if we can learn more from the error object.
					console.log(e);
					Logger.error(`Creating hub failed ${e.message}`, CredentialStore.ID);
					vscode.window.showErrorMessage(vscode.l10n.t('Unable to sign in with the provided credentials'));
				}
			}
			if (!isEnterprise(authProviderId)) {
				Logger.debug('Setting hub and scopes', CredentialStore.ID);
				this._githubAPI = github;
				this._scopes = usedScopes;
			} else {
				Logger.debug('Setting enterprise hub and scopes', CredentialStore.ID);
				this._githubEnterpriseAPI = github;
				this._scopesEnterprise = usedScopes;
			}
			await this.saveScopesInState();

			if (!this._isInitialized || (isNew && !this._isSamling)) {
				this._isInitialized = true;
				this._onDidInitialize.fire();
			}
			if (isNew) {
				/* __GDPR__
					"auth.session" : {}
				*/
				this._telemetry.sendTelemetryEvent('auth.session');
			}
			return authResult;
		} else {
			Logger.debug(`No GitHub${getGitHubSuffix(authProviderId)} token found.`, CredentialStore.ID);
			return authResult;
		}
	}

	private async doCreate(options: vscode.AuthenticationGetSessionOptions, additionalScopes: boolean = false): Promise<AuthResult> {
		let enterprise: AuthResult | undefined;
		const initializeEnterprise = async () => {
			enterprise = await this.initialize(AuthProvider.githubEnterprise, options, additionalScopes ? SCOPES_WITH_ADDITIONAL : undefined, additionalScopes);
		};
		if (hasEnterpriseUri()) {
			await initializeEnterprise();
		} else {
			// Listen for changes to the enterprise URI and try again if it changes.
			initBasedOnSettingChange(GITHUB_ENTERPRISE, URI, hasEnterpriseUri, initializeEnterprise, this.context.subscriptions);
		}
		const githubOptions = { ...options };
		if (enterprise && !enterprise.canceled) {
			githubOptions.silent = true;
		}
		const github = await this.initialize(AuthProvider.github, githubOptions, additionalScopes ? SCOPES_WITH_ADDITIONAL : undefined, additionalScopes);
		return {
			canceled: github.canceled || !!(enterprise && enterprise.canceled)
		};
	}

	public async create(options: vscode.AuthenticationGetSessionOptions = {}, additionalScopes: boolean = false) {
		return this.doCreate(options, additionalScopes);
	}

	public async recreate(reason?: string): Promise<AuthResult> {
		return this.doCreate({ forceNewSession: reason ? { detail: reason } : true });
	}

	public async reset() {
		this._githubAPI = undefined;
		this._githubEnterpriseAPI = undefined;
		return this.create();
	}

	public isAnyAuthenticated() {
		return this.isAuthenticated(AuthProvider.github) || this.isAuthenticated(AuthProvider.githubEnterprise);
	}

	public isAuthenticated(authProviderId: AuthProvider): boolean {
		if (!isEnterprise(authProviderId)) {
			return !!this._githubAPI;
		}
		return !!this._githubEnterpriseAPI;
	}

	public isAuthenticatedWithAdditionalScopes(authProviderId: AuthProvider): boolean {
		if (!isEnterprise(authProviderId)) {
			return !!this._githubAPI && this.allScopesIncluded(this._scopes, SCOPES_WITH_ADDITIONAL);
		}
		return !!this._githubEnterpriseAPI && this.allScopesIncluded(this._scopesEnterprise, SCOPES_WITH_ADDITIONAL);
	}

	public getHub(authProviderId: AuthProvider): GitHub | undefined {
		if (!isEnterprise(authProviderId)) {
			return this._githubAPI;
		}
		return this._githubEnterpriseAPI;
	}

	public areScopesOld(authProviderId: AuthProvider): boolean {
		if (!isEnterprise(authProviderId)) {
			return !this.allScopesIncluded(this._scopes, SCOPES_OLD);
		}
		return !this.allScopesIncluded(this._scopesEnterprise, SCOPES_OLD);
	}

	public areScopesExtra(authProviderId: AuthProvider): boolean {
		if (!isEnterprise(authProviderId)) {
			return this.allScopesIncluded(this._scopes, SCOPES_WITH_ADDITIONAL);
		}
		return this.allScopesIncluded(this._scopesEnterprise, SCOPES_WITH_ADDITIONAL);
	}

	public async getHubEnsureAdditionalScopes(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		const hasScopesAlready = this.isAuthenticatedWithAdditionalScopes(authProviderId);
		await this.initialize(authProviderId, { createIfNone: !hasScopesAlready }, SCOPES_WITH_ADDITIONAL, true);
		if (!hasScopesAlready) {
			this._onDidUpgradeSession.fire();
		}
		return this.getHub(authProviderId);
	}

	public async getHubOrLogin(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		if (!isEnterprise(authProviderId)) {
			return this._githubAPI ?? (await this.login(authProviderId));
		}
		return this._githubEnterpriseAPI ?? (await this.login(authProviderId));
	}

	public async showSignInNotification(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		if (PersistentState.fetch(PROMPT_FOR_SIGN_IN_SCOPE, PROMPT_FOR_SIGN_IN_STORAGE_KEY) === false) {
			return;
		}

		const result = await vscode.window.showInformationMessage(
			vscode.l10n.t('In order to use the Pull Requests functionality, you must sign in to GitHub{0}', getGitHubSuffix(authProviderId)),
			SIGNIN_COMMAND,
			IGNORE_COMMAND,
		);

		if (result === SIGNIN_COMMAND) {
			return await this.login(authProviderId);
		} else {
			// user cancelled sign in, remember that and don't ask again
			PersistentState.store(PROMPT_FOR_SIGN_IN_SCOPE, PROMPT_FOR_SIGN_IN_STORAGE_KEY, false);

			/* __GDPR__
				"auth.cancel" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.cancel');
		}
	}

	public async login(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		const errorPrefix = vscode.l10n.t('Error signing in to GitHub{0}', getGitHubSuffix(authProviderId));
		let retry: boolean = true;
		let octokit: GitHub | undefined = undefined;
		const sessionOptions: vscode.AuthenticationGetSessionOptions = { createIfNone: true };
		let isCanceled: boolean = false;
		while (retry) {
			try {
				await this.initialize(authProviderId, sessionOptions);
			} catch (e) {
				Logger.error(`Login error: ${errorPrefix}: ${e}`, CredentialStore.ID);
				if (e instanceof Error && e.stack) {
					Logger.error(e.stack, CredentialStore.ID);
				}
				if (e.message === 'Cancelled') {
					isCanceled = true;
				}
			}
			octokit = this.getHub(authProviderId);
			if (octokit || isCanceled) {
				retry = false;
			} else {
				retry = (await vscode.window.showErrorMessage(errorPrefix, TRY_AGAIN, CANCEL)) === TRY_AGAIN;
				if (retry) {
					sessionOptions.forceNewSession = true;
					sessionOptions.createIfNone = undefined;
				}
			}
		}

		if (octokit) {
			/* __GDPR__
				"auth.success" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.success');
		} else {
			/* __GDPR__
				"auth.fail" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.fail');
		}

		return octokit;
	}

	public async showSamlMessageAndAuth(organizations: string[]): Promise<AuthResult> {
		this._isSamling = true;
		const result = await this.recreate(vscode.l10n.t('GitHub Pull Requests requires that you provide SAML access to your organization ({0}) when you sign in.', organizations.join(', ')));
		this._isSamling = false;
		return result;
	}

	public async isCurrentUser(authProviderId: AuthProvider, username: string): Promise<boolean> {
		const api = authProviderId === AuthProvider.github ? this._githubAPI : this._githubEnterpriseAPI;
		return (await api?.currentUser)?.login === username;
	}

	public async getIsEmu(authProviderId: AuthProvider): Promise<boolean> {
		const github = this.getHub(authProviderId);
		return !!(await github?.isEmu);
	}

	public getCurrentUser(authProviderId: AuthProvider): Promise<IAccount> {
		const github = this.getHub(authProviderId);
		const octokit = github?.octokit;
		return (octokit && github?.currentUser)!;
	}

	private setCurrentUser(github: GitHub): void {
		const getUser: ReturnType<typeof github.octokit.api.users.getAuthenticated> = new Promise((resolve, reject) => {
			Logger.debug('Getting current user', CredentialStore.ID);
			github.octokit.call(github.octokit.api.users.getAuthenticated, {}).then(result => {
				Logger.debug(`Got current user ${result.data.login}`, CredentialStore.ID);
				resolve(result);
			}).catch(e => {
				Logger.error(`Failed to get current user: ${e}, ${e.message}`, CredentialStore.ID);
				reject(e);
			});
		});
		github.currentUser = getUser.then(result => convertRESTUserToAccount(result.data));
		github.isEmu = getUser.then(result => result.data.plan?.name === 'emu_user');
	}

	private async getSession(authProviderId: AuthProvider, getAuthSessionOptions: vscode.AuthenticationGetSessionOptions, scopes: string[], requireScopes: boolean): Promise<{ session: vscode.AuthenticationSession | undefined, isNew: boolean, scopes: string[] }> {
		const existingSession = (getAuthSessionOptions.forceNewSession || requireScopes) ? undefined : await this.findExistingScopes(authProviderId);
		if (existingSession?.session) {
			return { session: existingSession.session, isNew: false, scopes: existingSession.scopes };
		}

		const session = await vscode.authentication.getSession(authProviderId, requireScopes ? scopes : SCOPES_OLD, getAuthSessionOptions);
		return { session, isNew: !!session, scopes: requireScopes ? scopes : SCOPES_OLD };
	}

	private async findExistingScopes(authProviderId: AuthProvider): Promise<{ session: vscode.AuthenticationSession, scopes: string[] } | undefined> {
		const scopesInPreferenceOrder = [SCOPES_WITH_ADDITIONAL, SCOPES_OLD, SCOPES_OLDEST];
		for (const scopes of scopesInPreferenceOrder) {
			const session = await vscode.authentication.getSession(authProviderId, scopes, { silent: true });
			if (session) {
				return { session, scopes };
			}
		}
	}

	private async createHub(token: string, authProviderId: AuthProvider): Promise<GitHub> {
		let baseUrl = 'https://api.github.com';
		let enterpriseServerUri: vscode.Uri | undefined;
		Logger.appendLine(`Creating hub for ${isEnterprise(authProviderId) ? 'enterprise' : '.com'}`, CredentialStore.ID);
		if (isEnterprise(authProviderId)) {
			enterpriseServerUri = getEnterpriseUri();
		}

		const isGhe = enterpriseServerUri?.authority.endsWith('ghe.com');

		if (enterpriseServerUri) {
			Logger.appendLine(`Enterprise server authority ${enterpriseServerUri.authority}`, CredentialStore.ID);
			if (isGhe) {
				baseUrl = `${enterpriseServerUri.scheme}://api.${enterpriseServerUri.authority}`;
			} else {
				baseUrl = `${enterpriseServerUri.scheme}://${enterpriseServerUri.authority}/api/v3`;
			}
		}

		let fetchCore: ((url: string, options: { headers?: Record<string, string> }) => any) | undefined;
		if (vscode.env.uiKind === vscode.UIKind.Web) {
			fetchCore = (url: string, options: { headers?: Record<string, string> }) => {
				if (options.headers !== undefined) {
					const { 'user-agent': userAgent, ...headers } = options.headers;
					if (userAgent) {
						options.headers = headers;
					}
				}
				return fetch(url, options);
			};
		}

		const octokit = new Octokit({
			request: { agent, fetch: fetchCore },
			userAgent: 'GitHub VSCode Pull Requests',
			// `shadow-cat-preview` is required for Draft PR API access -- https://developer.github.com/v3/previews/#draft-pull-requests
			previews: ['shadow-cat-preview', 'merge-info-preview'],
			auth: `${token || ''}`,
			baseUrl: baseUrl,
		});

		let graphQLBaseUrl = baseUrl;
		if (enterpriseServerUri && !isGhe) {
			graphQLBaseUrl = `${enterpriseServerUri.scheme}://${enterpriseServerUri.authority}/api`;
		}

		const graphql = new ApolloClient({
			link: link(graphQLBaseUrl, token || ''),
			cache: new InMemoryCache(),
			defaultOptions: {
				query: {
					fetchPolicy: 'no-cache',
				},
			},
		});

		const rateLogger = new RateLogger(this._telemetry, isEnterprise(authProviderId));
		const github: GitHub = {
			octokit: new LoggingOctokit(octokit, rateLogger),
			graphql: new LoggingApolloClient(graphql, rateLogger),
		};
		this.setCurrentUser(github);
		return github;
	}
}

const link = (url: string, token: string) =>
	setContext((_, { headers }) => ({
		headers: {
			...headers,
			authorization: token ? `Bearer ${token}` : '',
			Accept: 'application/vnd.github.merge-info-preview'
		},
	})).concat(
		createHttpLink({
			uri: `${url}/graphql`,
			// https://github.com/apollographql/apollo-link/issues/513
			fetch: fetch as any,
		}),
	);

function getGitHubSuffix(authProviderId: AuthProvider) {
	return !isEnterprise(authProviderId) ? '' : ' Enterprise';
}
