// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Services;
using Microsoft.SemanticKernel;
using System;
using System.ComponentModel;
using System.Text.Json;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Plugins;

/// <summary>
/// Plugin that provides access to Windows local file system via MCP
/// </summary>
public class LocalFileSystemPlugin
{
    private readonly LocalMcpProxyService _localMcp;
    private const string DefaultClientName = "default-client";

    public LocalFileSystemPlugin(LocalMcpProxyService localMcp)
    {
        _localMcp = localMcp;
    }

    [KernelFunction, Description("List all files and folders in a Windows directory on the user's local machine. Returns a JSON array with file names and paths. Use this to see what's in a folder.")]
    public async Task<string> ListLocalFiles(
        [Description("The folder path to list (e.g., C:\\POC\\test\\ or C:\\Users\\Username\\Documents)")] string folderPath,
        [Description("The user's Windows client name/machine name. Ask the user for their computer name if not known. Default: 'default-client'")] string clientName = DefaultClientName)
    {
        // Use search_files with * pattern to list all files in the directory
        var result = await _localMcp.SendMcpRequestAsync(
            clientName,
            "tools/call",
            new
            {
                name = "search_files",
                arguments = new
                {
                    startingDir = folderPath,
                    searchPatterns = "*"
                }
            });

        return result.ToString();
    }

    [KernelFunction, Description("Read the contents of a text file from the user's local Windows machine. Returns the file content as text.")]
    public async Task<string> ReadLocalFile(
        [Description("The full path to the file to read (e.g., C:\\POC\\test\\document.txt)")] string filePath,
        [Description("The user's Windows client name/machine name. Ask the user for their computer name if not known. Default: 'default-client'")] string clientName = DefaultClientName)
    {
        var result = await _localMcp.SendMcpRequestAsync(
            clientName,
            "tools/call",
            new
            {
                name = "read_text_file",
                arguments = new { filePath }
            });

        return result.ToString();
    }

    [KernelFunction, Description("Search for files on the user's local Windows machine matching specific patterns. Returns a JSON array of matching files with their paths.")]
    public async Task<string> SearchLocalFiles(
        [Description("The starting directory path (e.g., C:\\POC\\)")] string startingDir,
        [Description("Search pattern (e.g., *.pdf for PDF files, *.docx for Word documents, or * for all files)")] string searchPatterns,
        [Description("The user's Windows client name/machine name. Ask the user for their computer name if not known. Default: 'default-client'")] string clientName = DefaultClientName)
    {
        var result = await _localMcp.SendMcpRequestAsync(
            clientName,
            "tools/call",
            new
            {
                name = "search_files",
                arguments = new
                {
                    startingDir,
                    searchPatterns
                }
            });

        return result.ToString();
    }

    [KernelFunction, Description("Get detailed information about a specific file on the user's local Windows machine (size, created date, modified date, etc.). Returns file metadata as JSON.")]
    public async Task<string> GetLocalFileDetails(
        [Description("The full path to the file (e.g., C:\\POC\\test\\document.pdf)")] string filePath,
        [Description("The user's Windows client name/machine name. Ask the user for their computer name if not known. Default: 'default-client'")] string clientName = DefaultClientName)
    {
        var result = await _localMcp.SendMcpRequestAsync(
            clientName,
            "tools/call",
            new
            {
                name = "get_file_details",
                arguments = new { path = filePath }
            });

        return result.ToString();
    }
}
