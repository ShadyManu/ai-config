/**
 * Only the two options that deviate from Prettier's defaults are set here, so
 * that upgrades inherit upstream decisions rather than a frozen snapshot of
 * them. Everything else — two-space indentation, semicolons, trailing commas,
 * LF endings — is already the default.
 *
 * @type {import('prettier').Config}
 */
export default {
  // 80 would rewrap roughly two thirds of the existing sources; 100 matches the
  // width the code was actually written at.
  printWidth: 100,
  singleQuote: true,
};
