// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Semantic Kernel Plugin: Terms and Conditions Accepted
 *
 * Provides a function to reject previously accepted terms and conditions.
 */
export const termsAndConditionsAcceptedPlugin = {
  reject_terms_and_conditions: {
    name: 'reject_terms_and_conditions',
    description: 'Reject the terms and conditions on behalf of the user. Use when the user indicates they do not accept the terms and conditions.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
    execute: async (): Promise<string> => {
      // Import dynamically to avoid circular dependency
      const { setTermsAndConditionsAccepted } = await import('./agent');
      setTermsAndConditionsAccepted(false);
      return 'Terms and conditions rejected. You can accept later to proceed.';
    },
  },
};

/**
 * Semantic Kernel Plugin: Terms and Conditions Not Accepted
 *
 * Provides functions to accept terms and conditions or inform the user
 * that they must accept them before proceeding.
 */
export const termsAndConditionsNotAcceptedPlugin = {
  accept_terms_and_conditions: {
    name: 'accept_terms_and_conditions',
    description: 'Accept the terms and conditions on behalf of the user. Use when the user states they accept the terms and conditions.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
    execute: async (): Promise<string> => {
      const { setTermsAndConditionsAccepted } = await import('./agent');
      setTermsAndConditionsAccepted(true);
      return 'Terms and conditions accepted. Thank you.';
    },
  },
  terms_and_conditions_not_accepted: {
    name: 'terms_and_conditions_not_accepted',
    description: 'Inform the user that they must accept the terms and conditions to proceed. Use when the user tries to perform any action before accepting the terms and conditions.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
    execute: async (): Promise<string> => {
      return 'You must accept the terms and conditions to proceed.';
    },
  },
};
