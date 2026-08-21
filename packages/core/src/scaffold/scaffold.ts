import type {
  OverrideField,
  OverrideFieldType,
  ProviderOverrideSchema,
  OverrideTarget,
} from '../adapter/override.js';
import {
  OVERRIDE_SCHEMA_VERSION,
  orderedOptionFields,
  overridePath,
  validateOverrideDocument,
} from '../adapter/override.js';
import type { SourceKind } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import type { FileSystem } from '../fs/file-system.js';
import { checkName } from '../parse/name.js';
import { AI_DIRECTORY, SKILL_ENTRYPOINT } from '../parse/discover.js';
import { resolveWithinRoot } from '../path/safe-path.js';
import type { FrontmatterField, FrontmatterMap } from '../text/yaml-frontmatter.js';
import { renderMarkdownDocument, renderYamlEntries } from '../text/yaml-frontmatter.js';

export type ScaffoldOutcome =
  | { readonly ok: true; readonly created: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

export interface InstructionDraft {
  readonly name: string;
  readonly description?: string;
  readonly body: string;
  readonly applyTo?: readonly string[];
}

export interface AgentDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  /** Extra directories to create inside the skill, e.g. `references`. */
  readonly directories?: readonly string[];
}

export interface CommandDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Directories a skill may be scaffolded with, as documented by every provider. */
export const SKILL_SUBDIRECTORIES: readonly string[] = ['references', 'scripts', 'assets'];

const failure = (code: Diagnostic['code'], message: string, source: string): ScaffoldOutcome => ({
  ok: false,
  diagnostics: [{ code, severity: 'error', message, source }],
});

const checkDraftName = (name: string, source: string): Diagnostic | undefined => {
  const result = checkName(name);
  return result.ok
    ? undefined
    : {
        code: 'INVALID_NAME',
        severity: 'error',
        message: `Invalid name '${name}': ${result.reason}.`,
        source,
      };
};

/**
 * Writes planned files only if none of them already exists.
 *
 * All-or-nothing: a cancelled or rejected scaffold must not leave a half-built
 * artifact behind, and an existing file is never replaced, because everything
 * under `.ai/` is user-owned.
 */
const commit = async (
  fileSystem: FileSystem,
  root: string,
  files: readonly PlannedFile[],
  directories: readonly string[] = [],
): Promise<ScaffoldOutcome> => {
  for (const file of files) {
    if (await fileSystem.exists(resolveWithinRoot(root, file.path))) {
      return failure(
        'ALREADY_INITIALIZED',
        `'${file.path}' already exists. Edit it, or choose another name.`,
        file.path,
      );
    }
  }

  for (const directory of directories) {
    await fileSystem.createDirectory(resolveWithinRoot(root, directory));
  }
  for (const file of files) {
    const target = resolveWithinRoot(root, file.path);
    await fileSystem.createDirectory(resolveWithinRoot(root, parentOf(file.path)));
    await fileSystem.writeFileAtomic(target, Buffer.from(file.content, 'utf8'), {
      exclusive: true,
    });
  }

  return { ok: true, created: files.map((file) => file.path) };
};

const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
};

export const createInstruction = async (
  fileSystem: FileSystem,
  root: string,
  draft: InstructionDraft,
): Promise<ScaffoldOutcome> => {
  const path = `${AI_DIRECTORY}/instructions/${draft.name}.md`;
  const invalid = checkDraftName(draft.name, path);
  if (invalid !== undefined) {
    return { ok: false, diagnostics: [invalid] };
  }

  const fields: FrontmatterField[] = [];
  if (draft.description !== undefined && draft.description.trim().length > 0) {
    fields.push(['description', draft.description.trim()]);
  }
  const applyTo = (draft.applyTo ?? [])
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
  if (applyTo.length > 0) {
    fields.push(['applyTo', applyTo]);
  }

  return commit(fileSystem, root, [{ path, content: renderMarkdownDocument(fields, draft.body) }]);
};

export const createAgent = async (
  fileSystem: FileSystem,
  root: string,
  draft: AgentDraft,
): Promise<ScaffoldOutcome> => {
  const path = `${AI_DIRECTORY}/agents/${draft.name}.md`;
  const invalid = checkDraftName(draft.name, path);
  if (invalid !== undefined) {
    return { ok: false, diagnostics: [invalid] };
  }
  return commit(fileSystem, root, [
    {
      path,
      content: renderMarkdownDocument([['description', draft.description.trim()]], draft.body),
    },
  ]);
};

export const createSkill = async (
  fileSystem: FileSystem,
  root: string,
  draft: SkillDraft,
): Promise<ScaffoldOutcome> => {
  const directory = `${AI_DIRECTORY}/skills/${draft.name}`;
  const path = `${directory}/${SKILL_ENTRYPOINT}`;
  const invalid = checkDraftName(draft.name, path);
  if (invalid !== undefined) {
    return { ok: false, diagnostics: [invalid] };
  }

  const unknown = (draft.directories ?? []).find((name) => !SKILL_SUBDIRECTORIES.includes(name));
  if (unknown !== undefined) {
    return failure(
      'SKILL_FILE_UNSAFE_NAME',
      `Unknown skill directory '${unknown}'. Supported: ${SKILL_SUBDIRECTORIES.join(', ')}.`,
      directory,
    );
  }

  return commit(
    fileSystem,
    root,
    [
      {
        path,
        // `name` and `description` are what every provider requires, and the
        // canonical file is copied verbatim, so it is written exactly as the
        // Agent Skills spec describes it.
        content: renderMarkdownDocument(
          [
            ['name', draft.name],
            ['description', draft.description.trim()],
          ],
          draft.body,
        ),
      },
    ],
    (draft.directories ?? []).map((name) => `${directory}/${name}`),
  );
};

export const createCommand = async (
  fileSystem: FileSystem,
  root: string,
  draft: CommandDraft,
): Promise<ScaffoldOutcome> => {
  const path = `${AI_DIRECTORY}/commands/${draft.name}.md`;
  const invalid = checkDraftName(draft.name, path);
  if (invalid !== undefined) {
    return { ok: false, diagnostics: [invalid] };
  }
  return commit(fileSystem, root, [
    {
      path,
      content: renderMarkdownDocument([['description', draft.description.trim()]], draft.body),
    },
  ]);
};

/** Renders a provider override document from already-validated options. */
export const renderOverrideDocument = (
  schema: ProviderOverrideSchema,
  options: FrontmatterMap,
): string => {
  const fields = orderedOptionFields(schema, options);
  const lines = [
    `schema: ${String(OVERRIDE_SCHEMA_VERSION)}`,
    ...(fields.length === 0 ? ['options: {}'] : ['options:', ...renderYamlEntries(fields, '  ')]),
  ];
  return `${lines.join('\n')}\n`;
};

/** Written wherever a value is the author's to choose. */
export const TEMPLATE_PLACEHOLDER = 'TODO';

/** Column a generated comment wraps at, counted from the start of the line. */
const COMMENT_WIDTH = 88;

export interface OverrideTemplateDraft {
  readonly provider: ProviderId;
  readonly kind: SourceKind;
  readonly id: string;
  /** Field names to scaffold, as declared by the provider's schema. */
  readonly fields: readonly string[];
}

/**
 * Renders an override document in which every chosen setting is commented out.
 *
 * A template exists so a guided flow can ask *which* settings the author wants
 * without asking what each one should be: the values are then filled in with
 * the editor, where a model ID or a permission map is far easier to write than
 * through a sequence of input boxes.
 *
 * Everything below `options` is a comment, which is the only strategy that
 * satisfies both halves of the requirement. A placeholder written as a real
 * value would be rejected the moment it is a number, an enum or a boolean, and
 * a plausible value invented to satisfy the schema would be compiled into the
 * provider's files as though the author had chosen it. Commented lines keep the
 * file valid and inert until a real value replaces the placeholder.
 */
export const renderOverrideTemplate = (
  schema: ProviderOverrideSchema,
  draft: OverrideTemplateDraft,
): string => {
  const fields = schema.fields.filter((field) => draft.fields.includes(field.name));
  const body = renderTemplateNodes(templateTree(fields), '');

  return [
    `schema: ${String(OVERRIDE_SCHEMA_VERSION)}`,
    '',
    ...commentBlock(templateHeader(draft, schema, fields), ''),
    'options:',
    ...body.map((line) => (line.length === 0 ? '  #' : `  # ${line}`)),
    '',
  ].join('\n');
};

const templateHeader = (
  draft: OverrideTemplateDraft,
  schema: ProviderOverrideSchema,
  fields: readonly OverrideField[],
): readonly string[] => {
  const documentation = [
    ...new Set([
      ...fields.map((field) => field.documentation),
      ...(schema.passthrough === undefined ? [] : [schema.passthrough.documentation]),
    ]),
  ].sort();

  return [
    `${draft.provider} settings for the ${draft.kind} '${draft.id}'.`,
    '',
    `The canonical ${draft.kind} is still compiled to every enabled provider. What is set here changes only what ${draft.provider} receives.`,
    '',
    `Uncomment a setting and replace ${TEMPLATE_PLACEHOLDER} with a value. While a setting stays commented out it is not applied, and this file stays valid either way.`,
    ...(fields.some((field) => field.name.includes('.'))
      ? ['', 'For nested settings, uncomment the parent section and the setting below it together.']
      : []),
    // Said here rather than left to be discovered: the scaffold lists only the
    // settings AI Config knows, and without this the list reads as the limit.
    ...(schema.passthrough === undefined
      ? []
      : [
          '',
          `This list is not the limit. ${schema.passthrough.reason} Add such a setting by hand and AI Config writes it through unchanged.`,
        ]),
    ...(documentation.length === 0 ? [] : ['']),
    ...documentation.map((url) => `Reference: ${url}`),
  ];
};

/**
 * One node per key path segment, so a dotted field name such as
 * `interface.display_name` is scaffolded as the nested YAML it has to be.
 */
interface TemplateNode {
  readonly key: string;
  field: OverrideField | undefined;
  readonly children: TemplateNode[];
}

const templateTree = (fields: readonly OverrideField[]): readonly TemplateNode[] => {
  const roots: TemplateNode[] = [];

  for (const field of fields) {
    let siblings = roots;
    let node: TemplateNode | undefined;
    for (const segment of field.name.split('.')) {
      node = siblings.find((candidate) => candidate.key === segment);
      if (node === undefined) {
        node = { key: segment, field: undefined, children: [] };
        siblings.push(node);
      }
      siblings = node.children;
    }
    if (node !== undefined) {
      node.field = field;
    }
  }

  return roots;
};

const renderTemplateNodes = (nodes: readonly TemplateNode[], indent: string): readonly string[] => {
  const lines: string[] = [];

  for (const node of nodes) {
    if (lines.length > 0) {
      lines.push('');
    }
    const { field } = node;
    if (field === undefined) {
      lines.push(`${indent}${node.key}:`);
      lines.push(...renderTemplateNodes(node.children, `${indent}  `));
      continue;
    }
    lines.push(...prose(describeField(field), indent));
    lines.push(`${indent}${node.key}: ${placeholderFor(field.type)}`);
  }

  return lines;
};

const describeField = (field: OverrideField): readonly string[] => {
  const constraint = constraintOf(field.type, field.suggestions);
  return [
    field.description,
    ...(constraint === undefined ? [] : [constraint]),
    ...(field.defaultNote === undefined ? [] : [`Default: ${field.defaultNote}.`]),
  ];
};

/**
 * A shape hint for a value the flow no longer asks for.
 *
 * `[]` and `{}` say "a list goes here" and "a mapping goes here" in a way a
 * bare TODO cannot, which is what the author needs to see before uncommenting.
 */
const placeholderFor = (type: OverrideFieldType): string => {
  switch (type.kind) {
    case 'string':
      return TEMPLATE_PLACEHOLDER;
    case 'enum':
      return type.values.length === 1 && type.values[0] !== undefined
        ? type.values[0]
        : TEMPLATE_PLACEHOLDER;
    case 'enum-or-map':
    case 'number':
    case 'boolean':
      return TEMPLATE_PLACEHOLDER;
    case 'string-list':
    case 'string-or-string-list':
    case 'list':
    case 'map-list':
      return '[]';
    case 'map':
    case 'string-map':
      return '{}';
  }
};

const constraintOf = (
  type: OverrideFieldType,
  _suggestions: readonly string[] | undefined,
): string | undefined => {
  switch (type.kind) {
    case 'string':
      // Do not put model/provider examples in authored override files. A
      // suggestion in a scaffold looks like a preference and becomes stale as
      // providers publish new models. The reference documentation remains the
      // neutral place for this information.
      return undefined;

    case 'enum':
      return type.values.length <= 1 ? undefined : `One of: ${type.values.join(', ')}.`;

    case 'enum-or-map':
      return `One of: ${type.values.join(', ')}, or a mapping.`;

    case 'boolean':
      return 'true or false.';

    case 'number': {
      const noun = type.integer === true ? 'A whole number' : 'A number';
      if (type.min !== undefined && type.max !== undefined) {
        return `${noun} from ${String(type.min)} to ${String(type.max)}.`;
      }
      if (type.min !== undefined) {
        return `${noun}, at least ${String(type.min)}.`;
      }
      if (type.max !== undefined) {
        return `${noun}, at most ${String(type.max)}.`;
      }
      return `${noun}.`;
    }

    case 'string-list':
      return 'A list of strings.';

    case 'string-or-string-list':
      return 'A string or a prioritized list of strings.';

    case 'map':
      return 'A mapping.';

    case 'string-map':
      return 'A mapping from strings to strings.';

    case 'list':
      return 'A list.';

    case 'map-list':
      return 'A list of mappings.';
  }
};

/** Turns prose into `#` comment lines, wrapped so the file stays readable. */
const commentBlock = (paragraphs: readonly string[], indent: string): readonly string[] => {
  const width = Math.max(COMMENT_WIDTH - indent.length - 2, 20);
  return paragraphs.flatMap((paragraph) =>
    paragraph.length === 0
      ? [`${indent}#`]
      : wrap(paragraph, width).map((line) => `${indent}# ${line}`),
  );
};

/**
 * Wraps a setting's documentation without a `#` of its own.
 *
 * Every line of the options block already receives one when the block is
 * commented out, and it is the line the author deletes to enable a setting.
 * Documentation lines are not meant to be uncommented, so a second marker would
 * only make the file harder to read.
 */
const prose = (paragraphs: readonly string[], indent: string): readonly string[] => {
  // Four columns are reserved for the block's own indent and comment marker.
  const width = Math.max(COMMENT_WIDTH - indent.length - 4, 20);
  return paragraphs.flatMap((paragraph) =>
    wrap(paragraph, width).map((line) => `${indent}${line}`),
  );
};

const wrap = (text: string, width: number): readonly string[] => {
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/).filter((item) => item.length > 0)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
};

/**
 * Creates one override source file with every chosen setting commented out.
 *
 * Never overwrites: an override that already exists is edited in the editor,
 * and replacing it would discard values the author wrote by hand.
 */
export const createOverrideTemplate = async (
  fileSystem: FileSystem,
  root: string,
  draft: OverrideTemplateDraft,
  schema: ProviderOverrideSchema,
  target: OverrideTarget,
): Promise<ScaffoldOutcome> => {
  const path = overridePath(draft.provider, draft.kind, draft.id);

  const unavailable = schema.unavailableReason?.(target);
  if (unavailable !== undefined) {
    return failure('OVERRIDE_NOT_APPLICABLE', unavailable, path);
  }

  const declared = new Set(schema.fields.map((field) => field.name));
  const unknown = draft.fields.find((name) => !declared.has(name));
  if (unknown !== undefined) {
    return failure(
      'OVERRIDE_UNKNOWN_FIELD',
      `Unknown field '${unknown}'. Supported fields: ${[...declared].join(', ')}.`,
      path,
    );
  }

  if (draft.fields.length === 0) {
    return failure(
      'OVERRIDE_INVALID',
      `No provider settings were chosen, so there is nothing to write to '${path}'.`,
      path,
    );
  }

  return commit(fileSystem, root, [{ path, content: renderOverrideTemplate(schema, draft) }]);
};

export interface OverrideDraft {
  readonly provider: ProviderId;
  readonly kind: SourceKind;
  readonly id: string;
  /** Raw option values, validated here against the provider's schema. */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Creates one provider override source file.
 *
 * The values are validated through exactly the same path the loader uses, so a
 * file this produces can never be one the next `analyze` rejects.
 */
export const createOverride = async (
  fileSystem: FileSystem,
  root: string,
  draft: OverrideDraft,
  schema: ProviderOverrideSchema,
  target: OverrideTarget,
  options: { readonly force?: boolean } = {},
): Promise<ScaffoldOutcome> => {
  const path = overridePath(draft.provider, draft.kind, draft.id);

  const unavailable = schema.unavailableReason?.(target);
  if (unavailable !== undefined) {
    return failure('OVERRIDE_NOT_APPLICABLE', unavailable, path);
  }

  const validation = validateOverrideDocument(
    { schema: OVERRIDE_SCHEMA_VERSION, options: draft.options },
    schema,
    { provider: draft.provider, sourcePath: path },
  );
  if (validation.options === undefined) {
    return { ok: false, diagnostics: validation.diagnostics };
  }
  if (Object.keys(validation.options).length === 0) {
    return failure(
      'OVERRIDE_INVALID',
      `No provider-specific options were given, so there is nothing to write to '${path}'.`,
      path,
    );
  }

  const content = renderOverrideDocument(schema, validation.options);
  const absolute = resolveWithinRoot(root, path);

  if (options.force !== true) {
    return commit(fileSystem, root, [{ path, content }]);
  }

  await fileSystem.createDirectory(resolveWithinRoot(root, parentOf(path)));
  await fileSystem.writeFileAtomic(absolute, Buffer.from(content, 'utf8'));
  return { ok: true, created: [path] };
};

/** Deletes one override file. Never touches the canonical artifact. */
export const removeOverride = async (
  fileSystem: FileSystem,
  root: string,
  provider: ProviderId,
  kind: SourceKind,
  id: string,
): Promise<ScaffoldOutcome> => {
  const path = overridePath(provider, kind, id);
  const absolute = resolveWithinRoot(root, path);
  if (!(await fileSystem.exists(absolute))) {
    return failure('OVERRIDE_TARGET_MISSING', `'${path}' does not exist.`, path);
  }
  await fileSystem.deleteFile(absolute);
  return { ok: true, created: [] };
};
