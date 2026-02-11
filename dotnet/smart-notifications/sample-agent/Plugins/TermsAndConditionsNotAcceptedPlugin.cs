// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.SemanticKernel;
using Agent365TaskPersonalizationSampleAgent.Agents;
using System.ComponentModel;
using System.Threading.Tasks;

namespace Agent365TaskPersonalizationSampleAgent.Plugins;

public class TermsAndConditionsNotAcceptedPlugin
{
    [KernelFunction("accept_terms_and_conditions"), Description("Accept the terms and conditions on behalf of the user. Use when the user states they accept the terms and conditions.")]
    public Task<string> AcceptTermsAndConditionsAsync()
    {
        MyAgent.TermsAndConditionsAccepted = true;
        return Task.FromResult("Terms and conditions accepted. Thank you.");
    }

    [KernelFunction("terms_and_conditions_not_accepted"), Description("Inform the user that they must accept the terms and conditions to proceed. Use when the user tries to perform any action before accepting the terms and conditions.")]
    public Task<string> TermsAndConditionsNotAcceptedAsync()
    {
        return Task.FromResult("You must accept the terms and conditions to proceed.");
    }
}