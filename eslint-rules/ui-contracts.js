'use strict';

/**
 * Call-site guards for the shared UI contracts.
 *
 * TypeScript already rejects a missing required prop, but it cannot see a
 * contract that lives in a pair of props or in a spread. These rules pin the
 * parts a screen could otherwise quietly drop:
 *
 * - `EmptyState` renders its action only when `actionLabel` and `onAction`
 *   arrive together, so a call site must pass both or neither.
 * - `SwitchRow` is controlled: `title`, `value` and `onValueChange` must be
 *   named at the call site, and the uncontrolled Switch props are rejected.
 *
 * Keeping the rules here (rather than in a one-off selector) lets the tests in
 * `__tests__/ui-contract-lint-test.ts` exercise the exact rule ESLint runs.
 */

function elementName(node) {
  const { name } = node;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression' && name.property.type === 'JSXIdentifier') {
    return `${name.object.name}.${name.property.name}`;
  }
  return null;
}

function attributesByName(node) {
  const found = new Map();
  for (const attribute of node.attributes) {
    if (attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier') {
      found.set(attribute.name.name, attribute);
    }
  }
  return found;
}

function hasSpread(node) {
  return node.attributes.some((attribute) => attribute.type === 'JSXSpreadAttribute');
}

const emptyStateContract = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require EmptyState.actionLabel and EmptyState.onAction at a call site together.',
    },
    schema: [],
    messages: {
      pairedAction:
        "EmptyState shows its action only when both `actionLabel` and `onAction` are passed. Add the missing one, or pass neither.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (elementName(node) !== 'EmptyState') return;
        const attributes = attributesByName(node);
        const hasLabel = attributes.has('actionLabel');
        const hasAction = attributes.has('onAction');
        if (hasLabel !== hasAction) {
          context.report({ node, messageId: 'pairedAction' });
        }
      },
    };
  },
};

const switchRowContract = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require SwitchRow title, controlled value and onValueChange at a call site, and reject uncontrolled Switch props.',
    },
    schema: [],
    messages: {
      controlled:
        'SwitchRow is controlled: name `title`, `value` and `onValueChange` at the call site so the row cannot fall back to internal state.',
      uncontrolled:
        "SwitchRow is controlled: `{{name}}` is not part of its contract; use `value` and `onValueChange`.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (elementName(node) !== 'SwitchRow') return;
        const attributes = attributesByName(node);

        for (const name of ['defaultValue', 'onChange']) {
          if (attributes.has(name)) {
            context.report({ node, messageId: 'uncontrolled', data: { name } });
          }
        }

        const spread = hasSpread(node);
        const missing = ['title', 'value', 'onValueChange'].filter((name) => !attributes.has(name));
        if (spread || missing.length > 0) {
          context.report({ node, messageId: 'controlled' });
        }
      },
    };
  },
};

module.exports = {
  rules: {
    'empty-state-contract': emptyStateContract,
    'switch-row-contract': switchRowContract,
  },
};
