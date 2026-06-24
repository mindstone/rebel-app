'use strict';

/**
 * no-inline-provider-error-classify
 *
 * Structural guard for the `error_classifier_lossy_collapse` family (REBEL-6DC,
 * postmortem 260624; family members 260513 / 260621 / …).
 *
 * THE VECTOR (what this kills):
 *   A provider-client file (`src/core/rebelCore/clients/**`) reintroduces a
 *   DIVERGENT INLINE classifier — it reads a parsed provider error's `type` /
 *   `code` discriminators and then hand-folds an unrecognised signal into a
 *   literal `'server_error'` / `'unknown'` ModelErrorKind WITHOUT delegating to
 *   the shared classifier (`classifyStatus` / `classifyError` /
 *   `classifyHttpError` in `src/core/rebelCore/modelErrors.ts`).
 *
 *   This is exactly the bug the postmortem traced: the in-stream SSE chunk
 *   handler destructured `{ code, type, message }` off `maybeError.error` and
 *   defaulted to `let kind = 'server_error'`, so a Codex rate-limit collapsed to
 *   `server_error`, bypassed the rate-limit handler, and amplified cost. The fix
 *   delegates to the shared classifier; this rule prevents a future agent from
 *   re-inventing the inline allowlist.
 *
 * WHY NOT a `no-restricted-syntax` selector:
 *   `clients/**` legitimately mints `new ModelError('server_error', <static
 *   message>, <status>, this.provider)` for ~8 LOCAL TRANSPORT conditions (empty
 *   response body, stream first-chunk / idle timeout). A blanket literal-kind ban
 *   would fire on all of them and force `eslint-disable` directives (forbidden —
 *   the escape-hatch baseline must not rise). The distinguishing signal is the
 *   *provider-error discriminator read*, which only an inline classifier has —
 *   not expressible as a single tight selector, hence a custom AST rule.
 *
 * THE TIGHT SIGNATURE (fires only when ALL hold within one function):
 *   1. A literal `'server_error'` / `'unknown'` ModelErrorKind is constructed —
 *      either directly `new ModelError('server_error', …)` or via a local `kind`
 *      variable whose value resolves to one of those literals.
 *   2. The function reads a provider-error DISCRIMINATOR: `type` and/or `code`
 *      sourced from an `.error`-bearing object (member access `x.error.code` or
 *      destructuring `const { code, type } = x.error`). This is the
 *      inline-classifier fingerprint; the legit transport sites never read it.
 *   3. The function does NOT call the shared classifier
 *      (`classifyStatus` / `classifyError` / `classifyHttpError`). Delegating to
 *      it (the post-fix shape) is the sanctioned path and is exempt.
 *
 * The combination is what makes it zero-false-positive: legit transport mints
 * fail (2); the post-fix delegating site fails (3 — it calls classifyStatus);
 * unrelated `.type`/`.code` reads on stream events fail (1) (no literal-kind
 * ModelError mint in the same function). See the RuleTester fixtures in
 * `eslint-rules/__tests__/no-inline-provider-error-classify.test.js`.
 */

const SHARED_CLASSIFIER_NAMES = new Set([
  'classifyStatus',
  'classifyError',
  'classifyHttpError',
]);

const LOSSY_LITERAL_KINDS = new Set(['server_error', 'unknown']);

const DISCRIMINATOR_NAMES = new Set(['type', 'code']);

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function calleeName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node.property);
  if (node.type === 'ChainExpression') return calleeName(node.expression);
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current
    && (
      current.type === 'ChainExpression'
      || current.type === 'TSAsExpression'
      || current.type === 'TSTypeAssertion'
      || current.type === 'TSNonNullExpression'
      || current.type === 'TSInstantiationExpression'
    )
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionNode(node) {
  return Boolean(
    node
    && (
      node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression'
    ),
  );
}

/**
 * Walk a subtree, calling `visitor` on every node. Does NOT descend into nested
 * function bodies (so the analysis is scoped to one function's own statements) —
 * unless that nested function IS the root we started from.
 */
function traverse(root, visitor) {
  function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    visitor(node);
    if (node !== root && isFunctionNode(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') walk(child);
        }
      } else if (value && typeof value.type === 'string') {
        walk(value);
      }
    }
  }
  walk(root);
}

function isModelErrorConstructor(node) {
  return Boolean(
    node
    && node.type === 'NewExpression'
    && calleeName(node.callee) === 'ModelError',
  );
}

function literalKindOf(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped && unwrapped.type === 'Literal' && typeof unwrapped.value === 'string') {
    return unwrapped.value;
  }
  return null;
}

/**
 * True if `node` is a member read of `.type`/`.code` whose object chain contains
 * an `.error` property OR is named like a parsed error (`*error*` / `*err*` /
 * `body`). Conservative: we only treat a discriminator read as the
 * inline-classifier fingerprint when it is plausibly sourced from a provider
 * error body, never from a stream-event `.type`.
 */
function isErrorDiscriminatorMember(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  const prop = propertyName(node.property);
  if (!DISCRIMINATOR_NAMES.has(prop)) return false;
  return objectLooksLikeProviderError(node.object);
}

function objectLooksLikeProviderError(objectNode) {
  const obj = unwrapExpression(objectNode);
  if (!obj) return false;
  // `x.error.code` — the canonical provider-error-body shape.
  if (obj.type === 'MemberExpression' && propertyName(obj.property) === 'error') {
    return true;
  }
  // `maybeError.code` / `errorBody.type` — identifier named like an error body.
  if (obj.type === 'Identifier') {
    return /error|err|body/i.test(obj.name);
  }
  // `parsed.error` accessed then `.code` etc. handled above; also a bare
  // `.error` member used as the object.
  if (obj.type === 'MemberExpression') {
    return propertyName(obj.property) != null && /error|err|body/i.test(propertyName(obj.property));
  }
  return false;
}

/**
 * True if `node` destructures `code`/`type` from an `.error`-bearing /
 * error-named source — `const { code, type, message } = maybeError.error;`.
 */
function isErrorDiscriminatorDestructure(node) {
  if (!node || node.type !== 'VariableDeclarator') return false;
  if (!node.id || node.id.type !== 'ObjectPattern') return false;
  const destructuresDiscriminator = node.id.properties.some((p) =>
    p.type === 'Property' && DISCRIMINATOR_NAMES.has(propertyName(p.key)),
  );
  if (!destructuresDiscriminator) return false;
  return objectLooksLikeProviderError(node.init);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid divergent inline provider-error classifiers in client files that fold a signal-bearing error into a literal server_error/unknown kind without the shared classifier.',
    },
    schema: [],
    messages: {
      noInlineProviderErrorClassify:
        "Inline provider-error classification detected: this reads a provider error's type/code and mints a literal '{{kind}}' ModelError without delegating to the shared classifier. Route it through classifyStatus()/classifyError()/classifyHttpError() (src/core/rebelCore/modelErrors.ts) so a new provider signal is recognised everywhere by construction. This re-introduces the error_classifier_lossy_collapse family (REBEL-6DC postmortem 260624). Local transport mints (empty body / timeout) that DON'T read type/code are unaffected.",
    },
  },
  create(context) {
    function analyzeFunction(fnNode) {
      const body = fnNode.body;
      // Arrow functions with expression bodies can't host an inline classifier.
      if (!body || body.type !== 'BlockStatement') return;

      let callsSharedClassifier = false;
      let readsErrorDiscriminator = false;
      const lossyKindIdentifiers = new Set();
      const lossyModelErrorNodes = [];

      // First pass: collect signals across this function's own statements
      // (not descending into nested functions).
      traverse(fnNode, (node) => {
        if (node === fnNode) return;

        // (3) Shared classifier call → sanctioned path, exempts the function.
        if (node.type === 'CallExpression' && SHARED_CLASSIFIER_NAMES.has(calleeName(node.callee))) {
          callsSharedClassifier = true;
        }

        // (2) Provider-error discriminator read (member or destructure).
        if (isErrorDiscriminatorMember(node)) {
          readsErrorDiscriminator = true;
        }
        if (isErrorDiscriminatorDestructure(node)) {
          readsErrorDiscriminator = true;
        }

        // (1a) `let kind = 'server_error'` / reassignment to a lossy literal.
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
          const kind = literalKindOf(node.init);
          if (kind && LOSSY_LITERAL_KINDS.has(kind)) {
            lossyKindIdentifiers.add(node.id.name);
          }
        }
        if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
          const kind = literalKindOf(node.right);
          if (kind && LOSSY_LITERAL_KINDS.has(kind)) {
            lossyKindIdentifiers.add(node.left.name);
          }
        }

        // (1b) `new ModelError(...)` with a literal lossy kind, or with a
        // `kind` identifier that resolves to a lossy literal.
        if (isModelErrorConstructor(node)) {
          const firstArg = node.arguments[0];
          const literalKind = literalKindOf(firstArg);
          const unwrappedArg = unwrapExpression(firstArg);
          if (literalKind && LOSSY_LITERAL_KINDS.has(literalKind)) {
            lossyModelErrorNodes.push({ node, kind: literalKind });
          } else if (unwrappedArg && unwrappedArg.type === 'Identifier') {
            lossyModelErrorNodes.push({ node, identifier: unwrappedArg.name });
          }
        }
      });

      if (callsSharedClassifier || !readsErrorDiscriminator) return;

      for (const entry of lossyModelErrorNodes) {
        const kind = entry.kind
          ?? (entry.identifier && lossyKindIdentifiers.has(entry.identifier)
            ? 'server_error/unknown'
            : null);
        if (!kind) continue;
        context.report({
          node: entry.node,
          messageId: 'noInlineProviderErrorClassify',
          data: { kind },
        });
      }
    }

    return {
      FunctionDeclaration: analyzeFunction,
      FunctionExpression: analyzeFunction,
      ArrowFunctionExpression: analyzeFunction,
    };
  },
};
