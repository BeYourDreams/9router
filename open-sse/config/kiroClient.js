/**
 * Client fingerprint Kiro's Amazon surfaces (q.*, codewhisperer.*) accept.
 *
 * They parse `KiroIDE-<version>` out of the User-Agent and answer older
 * versions — or an unparsable token, which is what the old `kiro-ide/1.0.0`
 * looked like — with
 *   400 {"message":"This version of Kiro is no longer supported. …"}
 * before the body is even validated. The dash form is the only one the parser
 * recognises (`KiroIDE/1.4.154`, `kiro-ide/1.4.154` are both rejected).
 *
 * Why the fingerprint is brand-impersonating at all: Kiro's gateway has no
 * other way to tell us from their IDE.
 *
 * Leaf module on purpose (zero imports): the provider registry reaches client
 * bundles, and kiroConstants.js drags the translator with it.
 */

// Kiro IDE 1.4.154 is the current desktop release (kiro.dev changelog). The
// floor moves every few months; KIRO_IDE_VERSION bumps it without a rebuild.
export const KIRO_IDE_VERSION = process.env.KIRO_IDE_VERSION || "1.4.154";

export const KIRO_CLIENT_HEADERS = {
  "User-Agent": `AWS-SDK-JS/3.0.0 KiroIDE-${KIRO_IDE_VERSION}`,
  "X-Amz-User-Agent": `aws-sdk-js/3.0.0 KiroIDE-${KIRO_IDE_VERSION}`,
};