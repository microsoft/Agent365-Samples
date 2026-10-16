// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.ComponentModel;

namespace NotificationAgent.Tools
{
    public static class DateTimeFunctionTool
    {
        [Description("Use this tool to get the current date and time")]
        public static string getDate()
        {
            string date = DateTimeOffset.Now.ToString("F", null);
            return date;
        }
    }
}
