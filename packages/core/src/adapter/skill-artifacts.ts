import type { AiConfiguration } from '../domain/configuration.js';
import type { GeneratedFile } from './adapter.js';

/**
 * Mirrors every canonical skill under `directory`, byte-for-byte.
 *
 * All four providers read the same directory-based `SKILL.md` format, so
 * re-serializing would risk reordering keys, changing quoting, or dropping
 * fields a provider understands and AI Config does not. Adapters differ only in
 * where the skills go, which is the single parameter here.
 *
 * Files are referenced rather than embedded: with four providers enabled a
 * skill file becomes four artifacts, and carrying payloads would mean holding
 * and re-hashing every byte four times per sync.
 */
export const skillArtifacts = (
  configuration: AiConfiguration,
  directory: string,
): readonly GeneratedFile[] => {
  return configuration.skills.flatMap((skill) =>
    skill.files.map((file) => ({
      path: `${directory}/${skill.name}/${file.relativePath}`,
      source: { kind: 'skill' as const, name: skill.name },
      content: {
        kind: 'copy' as const,
        ref: { skill: skill.name, relativePath: file.relativePath },
      },
      // Preserve the canonical mode so consumers can distinguish a script
      // from declarative skill content before it is materialized.
      executable: file.executable,
    })),
  );
};
