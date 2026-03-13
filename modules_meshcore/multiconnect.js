/** @description MeshCentral Multi Connect Plugin - Agent Side (MeshCore) */
/** @version 1.0.0 */

// This module runs on each agent (endpoint) and handles incoming
// logon session commands from the server plugin.

function multiconnect_agent() {
    var obj = {};
    obj.name = 'multiconnect';

    // Listen for plugin commands from the server
    obj.on_console_action = function (command, args) {
        if (typeof command !== 'object') return;
        if (command.plugin !== 'multiconnect') return;

        switch (command.action) {
            case 'createSession':
                obj.createInteractiveSession(command, function (result) {
                    // Send result back to server
                    MeshServerSend({
                        action: 'plugin',
                        plugin: 'multiconnect',
                        pluginaction: 'sessionResult',
                        nodeId: command.nodeId,
                        result: result
                    });
                });
                break;

            case 'checkSession':
                obj.checkUserSession(command.username, function (result) {
                    MeshServerSend({
                        action: 'plugin',
                        plugin: 'multiconnect',
                        pluginaction: 'sessionCheck',
                        nodeId: command.nodeId,
                        result: result
                    });
                });
                break;

            case 'disconnectSession':
                obj.disconnectUserSession(command.username, function (result) {
                    MeshServerSend({
                        action: 'plugin',
                        plugin: 'multiconnect',
                        pluginaction: 'disconnectResult',
                        nodeId: command.nodeId,
                        result: result
                    });
                });
                break;
        }
    };

    /**
     * Create an interactive console session on this Windows machine
     * @param {object} command - { username, password, domain, accountType }
     * @param {function} callback - function(result)
     */
    obj.createInteractiveSession = function (command, callback) {
        if (process.platform !== 'win32') {
            callback({ success: false, error: 'Ce plugin ne supporte que Windows.' });
            return;
        }

        var username = command.username;
        var password = command.password;
        var domain = command.domain || '.';
        var accountType = command.accountType || 'domain';

        // Build the full username
        var fullUser;
        if (accountType === 'local') {
            fullUser = '.\\' + username;
        } else {
            fullUser = domain + '\\' + username;
        }

        // PowerShell script to create interactive session
        var psScript = [
            '$ErrorActionPreference = "SilentlyContinue"',
            '$fullUser = "' + fullUser.replace(/"/g, '`"') + '"',
            '$password = "' + password.replace(/"/g, '`"') + '"',
            '$target = "TERMSRV/127.0.0.1"',
            '',
            '# Store credentials',
            'cmdkey /generic:$target /user:$fullUser /pass:$password | Out-Null',
            '',
            '# Create RDP session locally',
            '$proc = Start-Process "mstsc.exe" -ArgumentList "/v:127.0.0.1" -PassThru -WindowStyle Hidden',
            'Start-Sleep -Seconds 5',
            '',
            '# Find the new session and connect to console',
            '$userName = "' + username + '"',
            '$quser = query user 2>$null',
            '$found = $false',
            'if ($quser) {',
            '    foreach ($line in $quser) {',
            '        if ($line -match $userName) {',
            '            if ($line -match "\\s+(\\d+)\\s+") {',
            '                $sid = $Matches[1]',
            '                tscon $sid /dest:console 2>$null',
            '                $found = $true',
            '                break',
            '            }',
            '        }',
            '    }',
            '}',
            '',
            '# Cleanup',
            'cmdkey /delete:$target | Out-Null',
            'if ($proc -and !$proc.HasExited) { Stop-Process -Id $proc.Id -Force 2>$null }',
            '',
            'if ($found) {',
            '    Write-Output "SUCCESS: Session console ouverte pour $fullUser"',
            '} else {',
            '    # Fallback: scheduled task approach',
            '    $taskName = "MC_Logon_" + $userName',
            '    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c echo logon"',
            '    Register-ScheduledTask -TaskName $taskName -Action $action -Force | Out-Null',
            '    $svc = New-Object -ComObject "Schedule.Service"',
            '    $svc.Connect()',
            '    $folder = $svc.GetFolder("\\")',
            '    $task = $folder.GetTask($taskName)',
            '    $def = $task.Definition',
            '    $def.Principal.LogonType = 3',
            '    $folder.RegisterTaskDefinition($taskName, $def, 6, $fullUser, $password, 3) | Out-Null',
            '    Start-ScheduledTask -TaskName $taskName',
            '    Start-Sleep -Seconds 3',
            '    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false 2>$null',
            '    Write-Output "SUCCESS: Session ouverte via tache planifiee pour $fullUser"',
            '}'
        ].join('\r\n');

        // Execute the PowerShell script
        try {
            var child = require('child_process').exec(
                'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "' +
                Buffer.from(psScript, 'utf16le').toString('base64') + '"',
                { timeout: 30000 },
                function (error, stdout, stderr) {
                    if (error) {
                        callback({ success: false, error: stderr || error.message });
                    } else {
                        var output = (stdout || '').trim();
                        callback({
                            success: output.indexOf('SUCCESS') >= 0,
                            output: output,
                            error: output.indexOf('SUCCESS') >= 0 ? null : output
                        });
                    }
                }
            );
        } catch (ex) {
            callback({ success: false, error: ex.toString() });
        }
    };

    /**
     * Check if a user has an active session
     */
    obj.checkUserSession = function (username, callback) {
        try {
            var child = require('child_process').exec(
                'query user',
                { timeout: 10000 },
                function (error, stdout) {
                    var lines = (stdout || '').split('\n');
                    var found = false;
                    for (var i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().indexOf(username.toLowerCase()) >= 0) {
                            found = true;
                            break;
                        }
                    }
                    callback({ hasSession: found, username: username });
                }
            );
        } catch (ex) {
            callback({ hasSession: false, username: username, error: ex.toString() });
        }
    };

    /**
     * Disconnect a user session
     */
    obj.disconnectUserSession = function (username, callback) {
        try {
            var child = require('child_process').exec(
                'query user',
                { timeout: 10000 },
                function (error, stdout) {
                    var lines = (stdout || '').split('\n');
                    for (var i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().indexOf(username.toLowerCase()) >= 0) {
                            var match = lines[i].match(/\s+(\d+)\s+/);
                            if (match) {
                                require('child_process').exec(
                                    'logoff ' + match[1],
                                    function () {
                                        callback({ success: true });
                                    }
                                );
                                return;
                            }
                        }
                    }
                    callback({ success: false, error: 'Session non trouvee' });
                }
            );
        } catch (ex) {
            callback({ success: false, error: ex.toString() });
        }
    };

    return obj;
}

// Register with the mesh agent
try {
    module.exports = multiconnect_agent();
} catch (ex) { }
