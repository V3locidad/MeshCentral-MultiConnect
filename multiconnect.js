/** @description MeshCentral Multi Connect Plugin - Server Side */
/** @version 1.0.0 */

module.exports.multiconnect = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.debug = obj.meshServer.debug;
    obj.db = null;
    obj.exports = [
        'onDeviceRefeshEnd',
        'registerPluginTab',
        'onWebUIStartupEnd',
        'getCredentialProfiles',
        'saveCredentialProfile',
        'deleteCredentialProfile',
        'connectDevices',
        'getConnectionLog'
    ];

    // ==========================================
    // SERVER STARTUP
    // ==========================================
    obj.server_startup = function () {
        // Initialize the database collection for credential profiles
        obj.db = require('./db.js').CreateDB(obj);
        if (obj.debug) console.log('[MultiConnect] Plugin started.');
    };

    // ==========================================
    // WEB UI HOOKS
    // ==========================================

    // Register a tab on the device page
    obj.registerPluginTab = function () {
        return { tabId: 'multiconnect', tabTitle: 'Multi Connect' };
    };

    // Called when device page is refreshed
    obj.onDeviceRefeshEnd = function () {
        return '';
    };

    // Called when Web UI finishes loading
    obj.onWebUIStartupEnd = function () {
        return '';
    };

    // ==========================================
    // SERVER ACTIONS (WebSocket command handler)
    // ==========================================
    obj.serveraction = function (command, myparent, grandparent) {
        var user = null;
        if (myparent && myparent.user) user = myparent.user;
        if (user == null) return;

        switch (command.pluginaction) {

            // ----------------------------------
            // CREDENTIAL PROFILES MANAGEMENT
            // ----------------------------------
            case 'getCredentialProfiles': {
                obj.db.getProfiles(user._id, function (err, docs) {
                    if (err) {
                        try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'getCredentialProfiles', error: err.toString(), profiles: [] })); } catch (ex) { }
                        return;
                    }
                    // Mask passwords before sending to client
                    var safeProfiles = (docs || []).map(function (p) {
                        return {
                            _id: p._id,
                            name: p.name,
                            domain: p.domain || '',
                            username: p.username,
                            accountType: p.accountType || 'domain',
                            hasPassword: (p.password && p.password.length > 0) ? true : false
                        };
                    });
                    try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'getCredentialProfiles', profiles: safeProfiles })); } catch (ex) { }
                });
                break;
            }

            case 'saveCredentialProfile': {
                if (!command.profile) return;
                var profile = {
                    name: command.profile.name || 'Sans nom',
                    domain: command.profile.domain || '',
                    username: command.profile.username || '',
                    password: command.profile.password || '',
                    accountType: command.profile.accountType || 'domain',
                    userId: user._id
                };
                if (command.profile._id) {
                    // Update existing
                    obj.db.updateProfile(command.profile._id, profile, user._id, function (err) {
                        obj.serveraction({ pluginaction: 'getCredentialProfiles' }, myparent, grandparent);
                    });
                } else {
                    // Create new
                    obj.db.addProfile(profile, function (err, newDoc) {
                        obj.serveraction({ pluginaction: 'getCredentialProfiles' }, myparent, grandparent);
                    });
                }
                break;
            }

            case 'deleteCredentialProfile': {
                if (!command.profileId) return;
                obj.db.deleteProfile(command.profileId, user._id, function (err) {
                    obj.serveraction({ pluginaction: 'getCredentialProfiles' }, myparent, grandparent);
                });
                break;
            }

            // ----------------------------------
            // MULTI-CONNECT ACTION
            // ----------------------------------
            case 'connectDevices': {
                if (!command.profileId || !command.nodeIds || command.nodeIds.length === 0) {
                    try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'connectResult', error: 'Profil ou postes manquants.', results: [] })); } catch (ex) { }
                    return;
                }

                // Fetch the credential profile (with password)
                obj.db.getProfileById(command.profileId, user._id, function (err, profile) {
                    if (err || !profile) {
                        try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'connectResult', error: 'Profil introuvable.', results: [] })); } catch (ex) { }
                        return;
                    }

                    var results = [];
                    var pending = command.nodeIds.length;

                    for (var i = 0; i < command.nodeIds.length; i++) {
                        (function (nodeId) {
                            // Build the PowerShell script to run on the agent
                            var psScript = obj.buildLogonScript(profile);

                            // Send the script execution command to the agent via MeshCentral's RunCommands
                            var meshServer = obj.meshServer;
                            try {
                                // Use the mesh server to run a command on the agent
                                meshServer.webserver.meshAgentHandler.runCommandOnAgent(
                                    nodeId, user, psScript, 'ps1',
                                    function (agentErr, output) {
                                        results.push({
                                            nodeId: nodeId,
                                            success: !agentErr,
                                            output: output || '',
                                            error: agentErr ? agentErr.toString() : null
                                        });

                                        // Log the connection attempt
                                        obj.db.addLog({
                                            userId: user._id,
                                            nodeId: nodeId,
                                            profileName: profile.name,
                                            username: profile.username,
                                            domain: profile.domain,
                                            timestamp: Date.now(),
                                            success: !agentErr
                                        });

                                        pending--;
                                        if (pending === 0) {
                                            try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'connectResult', results: results })); } catch (ex) { }
                                        }
                                    }
                                );
                            } catch (ex) {
                                // Fallback: use the console command approach
                                obj.runOnAgent(nodeId, user, psScript, myparent, function (success, output) {
                                    results.push({
                                        nodeId: nodeId,
                                        success: success,
                                        output: output || '',
                                        error: success ? null : 'Erreur agent'
                                    });

                                    obj.db.addLog({
                                        userId: user._id,
                                        nodeId: nodeId,
                                        profileName: profile.name,
                                        username: profile.username,
                                        domain: profile.domain,
                                        timestamp: Date.now(),
                                        success: success
                                    });

                                    pending--;
                                    if (pending === 0) {
                                        try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'connectResult', results: results })); } catch (ex) { }
                                    }
                                });
                            }
                        })(command.nodeIds[i]);
                    }
                });
                break;
            }

            // ----------------------------------
            // CONNECTION LOG
            // ----------------------------------
            case 'getConnectionLog': {
                obj.db.getLogs(user._id, 50, function (err, docs) {
                    try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'getConnectionLog', logs: docs || [] })); } catch (ex) { }
                });
                break;
            }
        }
    };

    // ==========================================
    // HELPER: Build PowerShell logon script
    // ==========================================
    obj.buildLogonScript = function (profile) {
        var domain = profile.domain || '.';
        var username = profile.username;
        var password = profile.password;

        // For domain accounts: DOMAIN\user, for local: .\user
        var fullUser = (profile.accountType === 'local') ? '.\\\\\' + username : domain + '\\\\' + username;

        // PowerShell script that creates an interactive console session
        // Strategy:
        // 1. Use cmdkey to store credentials
        // 2. Initiate a local RDP session to create the interactive logon
        // 3. Then use tscon to switch that session to the console
        // 4. Clean up stored credentials
        var script = `
$ErrorActionPreference = 'SilentlyContinue'
$domain = '${domain}'
$username = '${username}'
$password = '${password}'

# Build full username
if ('${profile.accountType}' -eq 'local') {
    $fullUser = ".\\$username"
} else {
    $fullUser = "$domain\\$username"
}

# Method 1: Try to create an interactive session via cmdkey + mstsc
try {
    # Store credentials temporarily
    $target = "TERMSRV/127.0.0.1"
    cmdkey /generic:$target /user:$fullUser /pass:$password | Out-Null
    
    # Start a local RDP session (this creates an interactive session)
    $rdpProcess = Start-Process "mstsc.exe" -ArgumentList "/v:127.0.0.1 /console" -PassThru -WindowStyle Hidden
    
    # Wait for session to establish
    Start-Sleep -Seconds 5
    
    # Find the new session and connect it to the console
    $sessions = query user 2>$null
    if ($sessions) {
        foreach ($line in $sessions) {
            if ($line -match $username) {
                $parts = $line.Trim() -split '\\s+'
                # Find session ID
                foreach ($part in $parts) {
                    if ($part -match '^\\d+$' -and [int]$part -gt 0) {
                        $sessionId = $part
                        # Connect this session to console
                        tscon $sessionId /dest:console 2>$null
                        break
                    }
                }
            }
        }
    }
    
    # Clean up stored credentials
    cmdkey /delete:$target | Out-Null
    
    # Kill the mstsc process if still running
    if ($rdpProcess -and !$rdpProcess.HasExited) {
        $rdpProcess.Kill()
    }
    
    Write-Output "OK: Session interactive ouverte pour $fullUser"
}
catch {
    Write-Output "ERREUR: $($_.Exception.Message)"
}

# Method 2 (fallback): Use PsExec-style approach with scheduled task
if (-not (query user 2>$null | Select-String $username)) {
    try {
        # Create a scheduled task that runs interactively
        $taskName = "MC_Logon_$username"
        $secPassword = ConvertTo-SecureString $password -AsPlainText -Force
        
        # Create task action (just open explorer to create interactive session)
        $action = New-ScheduledTaskAction -Execute "explorer.exe"
        $principal = New-ScheduledTaskPrincipal -UserId $fullUser -LogonType Interactive -RunLevel Highest
        
        # Register and run immediately
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
        
        # Set the password for the task
        $taskPath = "\\$taskName"
        $svc = New-Object -ComObject "Schedule.Service"
        $svc.Connect()
        $folder = $svc.GetFolder("\\")
        $task = $folder.GetTask($taskName)
        $def = $task.Definition
        $def.Principal.LogonType = 3  # TASK_LOGON_INTERACTIVE_TOKEN
        $folder.RegisterTaskDefinition($taskName, $def, 6, $fullUser, $password, 3) | Out-Null
        
        # Run it
        Start-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 3
        
        # Clean up the task
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
        
        Write-Output "OK: Session ouverte via tache planifiee pour $fullUser"
    }
    catch {
        Write-Output "ERREUR Fallback: $($_.Exception.Message)"
    }
}
`;
        return script;
    };

    // ==========================================
    // HELPER: Run script on agent via console
    // ==========================================
    obj.runOnAgent = function (nodeId, user, script, myparent, callback) {
        try {
            // Encode script to base64 for safe transport
            var scriptB64 = Buffer.from(script, 'utf8').toString('base64');

            // Build the agent command
            var agentCommand = {
                action: 'msg',
                type: 'console',
                nodeid: nodeId,
                value: 'powershell -EncodedCommand ' + scriptB64
            };

            // Send via the WebSocket infrastructure
            var meshServer = obj.meshServer;
            if (meshServer.webserver) {
                // Try to get the agent connection
                var agent = meshServer.webserver.wsagents[nodeId];
                if (agent) {
                    try {
                        agent.send(JSON.stringify({
                            action: 'runcommands',
                            type: 2, // 1=BAT, 2=PS
                            cmds: script
                        }));
                        if (callback) callback(true, 'Commande envoyee');
                    } catch (ex) {
                        if (callback) callback(false, ex.toString());
                    }
                } else {
                    if (callback) callback(false, 'Agent non connecte');
                }
            } else {
                if (callback) callback(false, 'WebServer non disponible');
            }
        } catch (ex) {
            if (callback) callback(false, ex.toString());
        }
    };

    return obj;
};
