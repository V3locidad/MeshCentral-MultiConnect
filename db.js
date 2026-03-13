/** @description MeshCentral Multi Connect Plugin - Database Layer */

module.exports.CreateDB = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.meshServer;

    // Get the plugin data collection from MeshCentral's database
    obj.getCollection = function () {
        // MeshCentral plugins can store data in the main DB using the plugin prefix
        return obj.meshServer.db;
    };

    // ==========================================
    // CREDENTIAL PROFILES
    // ==========================================

    /**
     * Get all credential profiles for a user
     */
    obj.getProfiles = function (userId, callback) {
        var db = obj.getCollection();
        try {
            db.GetAllType('multiconnect_profile', function (err, docs) {
                if (err) { callback(err, []); return; }
                // Filter by user
                var userProfiles = (docs || []).filter(function (d) {
                    return d.userId === userId;
                });
                callback(null, userProfiles);
            });
        } catch (ex) {
            // Fallback: use file-based storage
            obj.getProfilesFile(userId, callback);
        }
    };

    /**
     * Get a single profile by ID (includes password for server-side use)
     */
    obj.getProfileById = function (profileId, userId, callback) {
        var db = obj.getCollection();
        try {
            db.Get(profileId, function (err, docs) {
                if (err || !docs || docs.length === 0) {
                    callback(err || 'Not found', null);
                    return;
                }
                var profile = docs[0];
                // Security: verify ownership
                if (profile.userId !== userId) {
                    callback('Access denied', null);
                    return;
                }
                callback(null, profile);
            });
        } catch (ex) {
            obj.getProfileByIdFile(profileId, userId, callback);
        }
    };

    /**
     * Add a new credential profile
     */
    obj.addProfile = function (profile, callback) {
        var db = obj.getCollection();
        profile._id = 'multiconnect_profile_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        profile.type = 'multiconnect_profile';
        profile.created = Date.now();

        // Encrypt password before storage
        profile.password = obj.encryptPassword(profile.password);

        try {
            db.Set(profile, function (err) {
                callback(err, profile);
            });
        } catch (ex) {
            obj.addProfileFile(profile, callback);
        }
    };

    /**
     * Update an existing credential profile
     */
    obj.updateProfile = function (profileId, updates, userId, callback) {
        obj.getProfileById(profileId, userId, function (err, existing) {
            if (err || !existing) { callback(err || 'Not found'); return; }

            existing.name = updates.name || existing.name;
            existing.domain = updates.domain || existing.domain;
            existing.username = updates.username || existing.username;
            existing.accountType = updates.accountType || existing.accountType;
            existing.updated = Date.now();

            // Only update password if a new one is provided
            if (updates.password && updates.password.length > 0) {
                existing.password = obj.encryptPassword(updates.password);
            }

            var db = obj.getCollection();
            try {
                db.Set(existing, function (err) {
                    callback(err);
                });
            } catch (ex) {
                callback(ex.toString());
            }
        });
    };

    /**
     * Delete a credential profile
     */
    obj.deleteProfile = function (profileId, userId, callback) {
        // Verify ownership first
        obj.getProfileById(profileId, userId, function (err, profile) {
            if (err || !profile) { callback(err || 'Not found'); return; }
            var db = obj.getCollection();
            try {
                db.Remove(profileId, function (err) {
                    callback(err);
                });
            } catch (ex) {
                callback(ex.toString());
            }
        });
    };

    // ==========================================
    // CONNECTION LOGS
    // ==========================================

    /**
     * Add a connection log entry
     */
    obj.addLog = function (logEntry) {
        var db = obj.getCollection();
        logEntry._id = 'multiconnect_log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        logEntry.type = 'multiconnect_log';
        try {
            db.Set(logEntry);
        } catch (ex) {
            // Silently fail for logs
        }
    };

    /**
     * Get connection logs for a user
     */
    obj.getLogs = function (userId, limit, callback) {
        var db = obj.getCollection();
        try {
            db.GetAllType('multiconnect_log', function (err, docs) {
                if (err) { callback(err, []); return; }
                var userLogs = (docs || [])
                    .filter(function (d) { return d.userId === userId; })
                    .sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); })
                    .slice(0, limit || 50);
                callback(null, userLogs);
            });
        } catch (ex) {
            callback(null, []);
        }
    };

    // ==========================================
    // PASSWORD ENCRYPTION (basic obfuscation)
    // ==========================================

    /**
     * Simple encryption using MeshCentral's built-in crypto
     * In production, you should use the server's encryption key
     */
    obj.encryptPassword = function (plainPassword) {
        if (!plainPassword) return '';
        try {
            var crypto = require('crypto');
            var key = obj.getEncryptionKey();
            var iv = crypto.randomBytes(16);
            var cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            var encrypted = cipher.update(plainPassword, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            return iv.toString('hex') + ':' + encrypted;
        } catch (ex) {
            // Fallback: base64 encoding (not secure, but functional)
            return 'b64:' + Buffer.from(plainPassword).toString('base64');
        }
    };

    /**
     * Decrypt password
     */
    obj.decryptPassword = function (encryptedPassword) {
        if (!encryptedPassword) return '';
        try {
            if (encryptedPassword.startsWith('b64:')) {
                return Buffer.from(encryptedPassword.substring(4), 'base64').toString('utf8');
            }
            var crypto = require('crypto');
            var key = obj.getEncryptionKey();
            var parts = encryptedPassword.split(':');
            var iv = Buffer.from(parts[0], 'hex');
            var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            var decrypted = decipher.update(parts[1], 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (ex) {
            return encryptedPassword;
        }
    };

    /**
     * Get or derive an encryption key from MeshCentral's server configuration
     */
    obj.getEncryptionKey = function () {
        var crypto = require('crypto');
        try {
            // Use the server's session key as base for deriving our encryption key
            var serverKey = obj.meshServer.config.settings.sessionKey || obj.meshServer.certificateOperations.GetRootCertHash();
            return crypto.createHash('sha256').update(String(serverKey)).digest();
        } catch (ex) {
            // Fallback key derived from a fixed seed
            return crypto.createHash('sha256').update('MeshCentral-MultiConnect-DefaultKey').digest();
        }
    };

    // Override getProfileById to auto-decrypt password
    var _origGetProfileById = obj.getProfileById;
    obj.getProfileById = function (profileId, userId, callback) {
        _origGetProfileById(profileId, userId, function (err, profile) {
            if (!err && profile && profile.password) {
                profile.password = obj.decryptPassword(profile.password);
            }
            callback(err, profile);
        });
    };

    // ==========================================
    // FILE-BASED FALLBACK STORAGE
    // ==========================================
    obj._fileStore = null;
    obj._getFileStore = function () {
        if (obj._fileStore) return obj._fileStore;
        var fs = require('fs');
        var path = require('path');
        var storePath = path.join(obj.meshServer.datapath, 'multiconnect_data.json');
        try {
            obj._fileStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        } catch (ex) {
            obj._fileStore = { profiles: [], logs: [] };
        }
        return obj._fileStore;
    };

    obj._saveFileStore = function () {
        var fs = require('fs');
        var path = require('path');
        var storePath = path.join(obj.meshServer.datapath, 'multiconnect_data.json');
        try {
            fs.writeFileSync(storePath, JSON.stringify(obj._fileStore || { profiles: [], logs: [] }, null, 2));
        } catch (ex) { }
    };

    obj.getProfilesFile = function (userId, callback) {
        var store = obj._getFileStore();
        var profiles = (store.profiles || []).filter(function (p) { return p.userId === userId; });
        callback(null, profiles);
    };

    obj.getProfileByIdFile = function (profileId, userId, callback) {
        var store = obj._getFileStore();
        var profile = (store.profiles || []).find(function (p) { return p._id === profileId && p.userId === userId; });
        callback(profile ? null : 'Not found', profile || null);
    };

    obj.addProfileFile = function (profile, callback) {
        var store = obj._getFileStore();
        if (!store.profiles) store.profiles = [];
        store.profiles.push(profile);
        obj._saveFileStore();
        callback(null, profile);
    };

    return obj;
};
