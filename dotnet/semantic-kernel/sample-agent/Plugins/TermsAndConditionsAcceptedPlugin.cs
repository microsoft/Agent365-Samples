// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.SemanticKernel;
using Agent365SemanticKernelSampleAgent.Agents;
using System.ComponentModel;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Plugins;

public class TermsAndConditionsAcceptedPlugin
{
    [KernelFunction("reject_terms_and_conditions"), Description("Reject the terms and conditions on behalf of the user. Use when the user indicates they do not accept the terms and conditions.")]
    public Task<string> RejectTermsAndConditionsAsync()
    {
        MyAgent.TermsAndConditionsAccepted = false;
        return Task.FromResult("Terms and conditions rejected. You can accept later to proceed.");
    }
}