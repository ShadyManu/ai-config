import { TEMPLATE_PLACEHOLDER } from '@aiconfig/core';

/**
 * What a guided flow writes where content belongs.
 *
 * The flows collect structure — a name, a scope, which provider settings to
 * scaffold — and never long-form text: a description, a system prompt or a
 * procedure is written in an editor, not in an input box. Each artifact is
 * therefore created valid but unfinished, and says so in the place the author
 * has to visit anyway.
 *
 * Every placeholder is a body a validator accepts, so a freshly scaffolded
 * artifact never makes the project invalid before it has been filled in.
 */
export const TODO = TEMPLATE_PLACEHOLDER;

export const INSTRUCTION_BODY = `${TODO}: Add instruction content.`;
export const AGENT_BODY = `${TODO}: Add agent instructions.`;
export const SKILL_BODY = `${TODO}: Add skill instructions.`;
export const COMMAND_BODY = `${TODO}: Add command prompt.`;

/**
 * Placeholder descriptions, one per kind.
 *
 * A bare `TODO` says nothing about what belongs there, and the description is
 * compiled into every provider's files as written — so an unfilled one is read
 * by a model as though it were meaningful. Each says what the field is for,
 * because the kinds do not use it alike: an agent's and a skill's description
 * is what decides when they are selected at all, while an instruction's and a
 * command's is a label.
 */
export const INSTRUCTION_DESCRIPTION = `${TODO}: Describe what this instruction covers.`;
export const AGENT_DESCRIPTION = `${TODO}: Describe when this agent should be used.`;
export const SKILL_DESCRIPTION = `${TODO}: Describe when this skill should be used.`;
export const COMMAND_DESCRIPTION = `${TODO}: Describe what this command does.`;
