/** @description MeshCentral Multi Connect Plugin - Server Side */
/** @version 1.0.1 */

module.exports.multiconnect = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.debug = obj.meshServer.debug;
    obj.db = null;
    obj.path = require('path');
    obj.fs = require('fs');

    // IMPORTANT: exports array tells MeshCentral which functions to expose to the Web UI
    obj.exports = [
        'registerPluginTab',
        'onDeviceRefeshEnd',
        'onWebUIStartupEnd'
    ];

    // ==========================================
    // SERVER STARTUP
    // ==========================================
    obj.server_startup = function () {
        obj.db = require('./db.js').CreateDB(obj);
        if (obj.debug) console.log('[MultiConnect] Plugin started.');
    };

    // ==========================================
    // WEB UI HOOKS (these are called by MeshCentral's plugin system in the browser)
    // ==========================================

    obj.registerPluginTab = function () {
        return { tabId: 'multiconnect', tabTitle: 'Multi Connect' };
    };

    obj.onDeviceRefeshEnd = function () {
        return '<div id="multiconnect-device-tab"><p>Utilisez le panneau Multi Connect depuis <b>Mon Serveur</b> &gt; <b>Modules Compl&eacute;mentaires</b> &gt; <b>Multi Connect</b> pour connecter plusieurs postes.</p></div>';
    };

    obj.onWebUIStartupEnd = function () {
        return '';
    };

    // ==========================================
    // ADMIN PANEL (serves the plugin's admin page)
    // ==========================================
    obj.handleAdminReq = function (req, res, user) {
        var htmlPath = obj.path.join(__dirname, 'views', 'multiconnect.html');
        try {
            var html = obj.fs.readFileSync(htmlPath, 'utf8');
            res.send(html);
        } catch (ex) {
            res.send('<h3>Erreur: Impossible de charger l\'interface Multi Connect.</h3><p>' + ex.toString() + '</p>');
        }
    };

    // ==========================================
    // SERVER ACTIONS (WebSocket command handler)
    // ==========================================
    obj.serveraction = function (command, myparent, grandparent) {
        var user = null;
        if (myparent && myparent.user) user = myparent.user;
        if (user == null) return;

        switch (command.pluginaction) {

            case 'getCredentialProfiles': {
                obj.db.getProfiles(user._id, function (err, docs) {
                    if (err) {
                        try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'getCredentialProfiles', error: err.toString(), profiles: [] })); } catch (ex) { }
                        return;
                    }
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
                    obj.db.updateProfile(command.profile._id, profile, user._id, function (err) {
                        obj.serveraction({ pluginaction: 'getCredentialProfiles' }, myparent, grandparent);
                    });
                } else {
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

            case 'connectDevices': {
                if (!command.profileId || !command.nodeIds || command.nodeIds.length === 0) {
                    try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'connectResult', error: 'Profil ou postes manquants.', results: [] })); } catch (ex) { }
                    return;
                }

                obj.db.getProfileById(command.profileId, user._id, function (err, profile) {
                    if (err || !profile) {
                        try { myparent.ws.send(JSON.stringify({ action: 'plugin', plugin: 'multiconnect', pluginaction: 'connectResult', error: 'Profil introuvable.', results: [] })); } catch (ex) { }
                        return;
                    }

                    var results = [];
                    var pending = command.nodeIds.length;

                    for (var i = 0; i < command.nodeIds.length; i++) {
                        (function (nodeId) {
                            var psScript = obj.buildLogonScript(profile);
                            obj.runOnAgent(nodeId, user, psScript, myparent, function (success, output) {
                                results.push({
                                    nodeId: nodeId,
                                    success: success,
                                    output: output || '',
                                    error: success ? null : (output || 'Erreur agent')
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
                        })(command.nodeIds[i]);
                    }
                });
                break;
            }

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
        var domain = (profile.domain || '.').replace(/'/g, "''");
        var username = (profile.username || '').replace(/'/g, "''");
        var password = (profile.password || '').replace(/'/g, "''");
        var accountType = profile.accountType || 'domain';

        var script = [
            '$ErrorActionPreference = "SilentlyContinue"',
            "",
            "$domain = '" + domain + "'",
            "$username = '" + username + "'",
            "$password = '" + password + "'",
            "",
            "if ('" + accountType + "' -eq 'local') {",
            '    $fullUser = ".\\$username"',
            "} else {",
            '    $fullUser = "$domain\\$username"',
            "}",
            "",
            '# Method 1: cmdkey + local RDP + tscon',
            '$target = "TERMSRV/127.0.0.1"',
            'cmdkey /generic:$target /user:$fullUser /pass:$password | Out-Null',
            '$proc = Start-Process "mstsc.exe" -ArgumentList "/v:127.0.0.1" -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue',
            'Start-Sleep -Seconds 5',
            '',
            '$found = $false',
            '$quser = query user 2>$null',
            'if ($quser) {',
            '    foreach ($line in $quser) {',
            '        if ($line -match $username) {',
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
            'cmdkey /delete:$target 2>$null | Out-Null',
            'if ($proc -and !$proc.HasExited) { Stop-Process -Id $proc.Id -Force 2>$null }',
            '',
            'if ($found) { Write-Output "SUCCESS"; exit 0 }',
            '',
            '# Method 2: Scheduled task fallback',
            '$taskName = "MC_Logon_" + $username',
            'try {',
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
            '    Write-Output "SUCCESS"',
            '} catch {',
            '    Write-Output "ERROR: $($_.Exception.Message)"',
            '}'
        ].join('\r\n');

        return script;
    };

    // ==========================================
    // HELPER: Run PowerShell on agent
    // ==========================================
    obj.runOnAgent = function (nodeId, user, script, myparent, callback) {
        try {
            var meshServer = obj.meshServer;
            if (meshServer.webserver && meshServer.webserver.wsagents) {
                var agent = meshServer.webserver.wsagents[nodeId];
                if (agent) {
                    try {
                        agent.send(JSON.stringify({
                            action: 'runcommands',
                            type: 2,
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
