/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable import/order */
import * as React from 'react';

export const Icon = ({ className = '', src, title }: { className?: string; title?: string; src: string }) => (
	<span className={`icon ${className}`} title={title} dangerouslySetInnerHTML={{ __html: src }} />
);

export default Icon;

export const alertIcon = <Icon src={require('../../resources/icons/alert.svg')} />;
export const checkIcon = <Icon src={require('../../resources/icons/check.svg')} className='check' />;
export const skipIcon = <Icon src={require('../../resources/icons/skip.svg')} className='skip' />;
export const chevronIcon = <Icon src={require('../../resources/icons/chevron.svg')} />;
export const chevronDownIcon = <Icon src={require('../../resources/icons/chevron_down.svg')} />;
export const commentIcon = <Icon src={require('../../resources/icons/comment.svg')} />;
export const quoteIcon = <Icon src={require('../../resources/icons/quote.svg')} />;
export const commitIcon = <Icon src={require('../../resources/icons/commit_icon.svg')} />;
export const copyIcon = <Icon src={require('../../resources/icons/copy.svg')} />;
export const deleteIcon = <Icon src={require('../../resources/icons/delete.svg')} />;
export const mergeIcon = <Icon src={require('../../resources/icons/merge_icon.svg')} />;
export const mergeMethodIcon = <Icon src={require('../../resources/icons/merge_method.svg')} />;
export const prClosedIcon = <Icon src={require('../../resources/icons/pr_closed.svg')} />;
export const prOpenIcon = <Icon src={require('../../resources/icons/pr.svg')} />;
export const prDraftIcon = <Icon src={require('../../resources/icons/pr_draft.svg')} />;
export const editIcon = <Icon src={require('../../resources/icons/edit.svg')} />;
export const plusIcon = <Icon src={require('../../resources/icons/plus.svg')} />;
export const pendingIcon = <Icon src={require('../../resources/icons/dot.svg')} className='pending' />;
export const requestChanges = <Icon src={require('../../resources/icons/request_changes.svg')} />;
export const settingsIcon = <Icon src={require('../../resources/icons/settings.svg')} />;
export const closeIcon = <Icon src={require('../../resources/icons/close.svg')} className='close' />;
export const syncIcon = <Icon src={require('../../resources/icons/sync.svg')} />;
export const prBaseIcon = <Icon src={require('../../resources/icons/pr_base.svg')} />;
export const prMergeIcon = <Icon src={require('../../resources/icons/pr_merge.svg')} />;
export const gearIcon = <Icon src={require('../../resources/icons/gear.svg')} />;
export const assigneeIcon = <Icon src={require('../../resources/icons/assignee.svg')} />;
export const reviewerIcon = <Icon src={require('../../resources/icons/reviewer.svg')} />;
export const labelIcon = <Icon src={require('../../resources/icons/label.svg')} />;
export const milestoneIcon = <Icon src={require('../../resources/icons/milestone.svg')} />;
export const projectIcon = <Icon src={require('../../resources/icons/github-project.svg')} />;
export const sparkleIcon = <Icon src={require('../../resources/icons/sparkle.svg')} />;
export const stopCircleIcon = <Icon src={require('../../resources/icons/stop-circle.svg')} />;
export const issueIcon = <Icon src={require('../../resources/icons/issue.svg')} />;
export const issueClosedIcon = <Icon src={require('../../resources/icons/issue_closed.svg')} />;
export const copilotIcon = <Icon src={require('../../resources/icons/copilot.svg')} />;
export const threeBars = <Icon src={require('../../resources/icons/three-bars.svg')} />;
export const tasklistIcon = <Icon src={require('../../resources/icons/tasklist.svg')} />;
export const errorIcon = <Icon src={require('../../resources/icons/error.svg')} />;
export const loadingIcon = <Icon className='loading' src={require('../../resources/icons/loading.svg')} />;
export const copilotSuccessIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-success.svg')} />;
export const copilotErrorIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-error.svg')} />;
export const copilotInProgressIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-in-progress.svg')} />;
