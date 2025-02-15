'use strict';

exports.find = function(req, res, next) {
    req.query.username = req.query.username ? req.query.username : '';
    req.query.limit = req.query.limit ? parseInt(req.query.limit, null) : 20;
    req.query.page = req.query.page ? parseInt(req.query.page, null) : 1;
    req.query.sort = req.query.sort ? req.query.sort : '_id';

    var filters = {};
    if (req.query.username) {
        filters.username = { $like: '%' + req.query.username + '%' };
    }

    req.app.db.User.findAll({ where: filters })
        .then(function(results) {
            if (req.xhr) {
                res.header("Cache-Control", "no-cache, no-store, must-revalidate");
                res.send(results);
            } else {
                res.render('admin/users/index', {
                    data: {
                        results: JSON.stringify(results)
                    }
                });
            }
        })
        .catch(function(err) {
            return next(err);
        });
};

exports.read = function(req, res, next) {  
    var activeRegions = req.app.db.activeRegion.findAll({
        attributes: ['rc_region', 'region_name'],
        where: {
          is_active: true,
          rc_region: {ne: 'rc_test_region'}
        },
        order: 'region_name'
    });

    if(req.params.id == 'new') {
      activeRegions.then(activeRegions => {
        res.render('admin/users/details', {
          data: {
            record: escape(JSON.stringify({})),
            activeRegions: escape(JSON.stringify(activeRegions)),
            enabledRegions: escape(JSON.stringify([]))
          }
        });
      });
    } else {
      req.app.db.User.findById(req.params.id)
        .then(user => {
            return Promise.all([
                activeRegions,
                user.getActiveRegions(),
                user])
      }).then(function ([activeRegions, enabledRegions, user]) {
          if (req.xhr) {
              res.send(user);
          } else {
              res.render('admin/users/details', {
                  data: {
                      record: escape(JSON.stringify(user)),
                      activeRegions: escape(JSON.stringify(activeRegions)),
                      enabledRegions: escape(JSON.stringify(enabledRegions))
                  }
              });
          }
      }).catch(function(err) {
          return next(err);
      });
    }
};

exports.update = function(req, res, next) {
    updateOrCreate(req, res, false);
}

exports.create = function(req, res, next) {
    updateOrCreate(req, res, true);
}

var updateOrCreate = function(req, res, newUser) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.body.siteAdmin) {
            req.body.siteAdmin = false;
        }

        if (!req.body.username) {
            workflow.outcome.errfor.username = 'required';
            workflow.outcome.errors.push('Error with username.');
        } else if (!/^[a-zA-Z0-9\-\_]+$/.test(req.body.username)) {
            workflow.outcome.errfor.username = 'only use letters, numbers, \'-\', \'_\'';
            workflow.outcome.errors.push('Error with username.');
        }

        if (!req.body.email) {
            workflow.outcome.errfor.email = 'required';
            workflow.outcome.errors.push('Error with email.');
        } else if (!/^[a-zA-Z0-9\-\_\.\+]+@[a-zA-Z0-9\-\_\.]+\.[a-zA-Z0-9\-\_]+$/.test(req.body.email)) {
            workflow.outcome.errfor.email = 'invalid email format';
            workflow.outcome.errors.push('Error with email.');
        }

        if (req.body.newPassword !== req.body.confirm) {
            workflow.outcome.errfor.password = 'passwords do not match';
            workflow.outcome.errors.push('Passwords do not match.');
        }

        if (newUser && !req.body.newPassword) {
            workflow.outcome.errfor.password = 'password required';
            workflow.outcome.errors.push('Password Required for New User');
        }

        if (workflow.hasErrors()) {
            return workflow.emit('response');
        }

        workflow.emit('duplicateUsernameCheck');
    });

    workflow.on('duplicateUsernameCheck', function() {
        var whereClause = { username: req.body.username };
        if(!newUser) {
            whereClause.id = { $ne: req.params.id };
        }
        req.app.db.User.findOne({ where: whereClause }
        ).then(function(user) {
            if (user) {
                workflow.outcome.errfor.username = 'username already taken';
                workflow.outcome.errors.push('Problem with username.');
                return workflow.emit('response');
            }

            workflow.emit('duplicateEmailCheck');
        });
    });

    workflow.on('duplicateEmailCheck', function() {
        var whereClause = { email: req.body.email.toLowerCase() };
        if(!newUser) {
            whereClause.id = { $ne: req.params.id };
        }
        req.app.db.User.findOne({ where: whereClause }
        ).then(function(user) {
            if (user) {
                workflow.outcome.errfor.email = 'email already taken';
                workflow.outcome.errors.push('Problem with email.');
                return workflow.emit('response');
            }

            workflow.emit('patchUser');
        });
    });

    workflow.on('patchUser', function() {
        var save = function(pwHash) {

            (newUser ?
                req.app.db.User.create({username: req.body.username}) :
                req.app.db.User.findById(req.params.id))
                .then(function(user) {
                    user.siteAdmin = req.body.siteAdmin;
                    user.isActive = req.body.isActive ? "yes" : "no";
                    user.username = req.body.username;
                    user.name = req.body.name;
                    user.email = req.body.email.toLowerCase();
                    if(pwHash) {
                        user.password = pwHash;
                    }
                    return user.save()
                }).then(user => {
                    return Promise.all([
                        user,
                        req.app.db.activeRegion.findAll({
                            where: {
                                is_active: true,
                                rc_region:
                                req.body.activeRegions
                                    .filter(region => { return region.enabled; })
                                    .map(region => { return region.rc_region; })
                            }
                        })
                    ])
                }).then(function ([user, newRegions]) {
                    newRegions.forEach(region => {
                       region.regionPermission = {
                           contact:
                           req.body.activeRegions.find(reqRegion => {
                               return reqRegion.rc_region == region.rc_region
                           }).contact
                       }
                   })
                   return Promise.all([user, user.setActiveRegions(newRegions)]);
               }).then(user => {
                   workflow.outcome.user = user;
                   workflow.emit('response');
               });
        }

        if(req.body.newPassword) {
            req.app.db.User.encryptPassword(req.body.newPassword, function(err, hash) {
                if (err) {
                    return workflow.emit('exception', err);
                }
                save(hash);
            });
        } else {
            save(false);
        }
    });

    // This is for patching properties from the list view, so less validation
    // is required.  Currently only used for active/siteAdmin, but if in the future
    // there is a need to patch things that need validation, consider going through
    // entire validation process
    workflow.on('patchProperties', function() {
        var fieldsToSet = {
            siteAdmin: req.body.siteAdmin,
            isActive: req.body.isActive ? "yes" : "no"
        };

        req.app.db.User.update(fieldsToSet, {where: {id: req.params.id} })
            .then(function(user, err) {
                workflow.emit('response');
            });
    });

    if(req.body.propertiesOnly) {
        workflow.emit('patchProperties');
    } else {
        workflow.emit('validate');
    }
};

exports.regions = function(req, res, next) {
};

exports.linkAdmin = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not link users to admins.');
            return workflow.emit('response');
        }

        if (!req.body.newAdminId) {
            workflow.outcome.errfor.newAdminId = 'required';
            return workflow.emit('response');
        }

        workflow.emit('verifyAdmin');
    });

    workflow.on('verifyAdmin', function(callback) {
        req.app.db.models.Admin.findById(req.body.newAdminId).exec(function(err, admin) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!admin) {
                workflow.outcome.errors.push('Admin not found.');
                return workflow.emit('response');
            }

            if (admin.user.id && admin.user.id !== req.params.id) {
                workflow.outcome.errors.push('Admin is already linked to a different user.');
                return workflow.emit('response');
            }

            workflow.admin = admin;
            workflow.emit('duplicateLinkCheck');
        });
    });

    workflow.on('duplicateLinkCheck', function(callback) {
        req.app.db.models.User.findOne({
            'roles.admin': req.body.newAdminId,
            _id: {
                $ne: req.params.id
            }
        }).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (user) {
                workflow.outcome.errors.push('Another user is already linked to that admin.');
                return workflow.emit('response');
            }

            workflow.emit('patchUser');
        });
    });

    workflow.on('patchUser', function(callback) {
        req.app.db.models.User.findById(req.params.id).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            user.roles.admin = req.body.newAdminId;
            user.save(function(err, user) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                user.populate('roles.admin roles.account', 'name.full', function(err, user) {
                    if (err) {
                        return workflow.emit('exception', err);
                    }

                    workflow.outcome.user = user;
                    workflow.emit('patchAdmin');
                });
            });
        });
    });

    workflow.on('patchAdmin', function() {
        workflow.admin.user = {
            id: req.params.id,
            name: workflow.outcome.user.username
        };
        workflow.admin.save(function(err, admin) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

exports.unlinkAdmin = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not unlink users from admins.');
            return workflow.emit('response');
        }

        if (req.user._id === req.params.id) {
            workflow.outcome.errors.push('You may not unlink yourself from admin.');
            return workflow.emit('response');
        }

        workflow.emit('patchUser');
    });

    workflow.on('patchUser', function() {
        req.app.db.models.User.findById(req.params.id).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!user) {
                workflow.outcome.errors.push('User was not found.');
                return workflow.emit('response');
            }

            var adminId = user.roles.admin;
            user.roles.admin = null;
            user.save(function(err, user) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                user.populate('roles.admin roles.account', 'name.full', function(err, user) {
                    if (err) {
                        return workflow.emit('exception', err);
                    }

                    workflow.outcome.user = user;
                    workflow.emit('patchAdmin', adminId);
                });
            });
        });
    });

    workflow.on('patchAdmin', function(id) {
        req.app.db.models.Admin.findById(id).exec(function(err, admin) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!admin) {
                workflow.outcome.errors.push('Admin was not found.');
                return workflow.emit('response');
            }

            admin.user = undefined;
            admin.save(function(err, admin) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                workflow.emit('response');
            });
        });
    });

    workflow.emit('validate');
};

exports.linkAccount = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not link users to accounts.');
            return workflow.emit('response');
        }

        if (!req.body.newAccountId) {
            workflow.outcome.errfor.newAccountId = 'required';
            return workflow.emit('response');
        }

        workflow.emit('verifyAccount');
    });

    workflow.on('verifyAccount', function(callback) {
        req.app.db.models.Account.findById(req.body.newAccountId).exec(function(err, account) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!account) {
                workflow.outcome.errors.push('Account not found.');
                return workflow.emit('response');
            }

            if (account.user.id && account.user.id !== req.params.id) {
                workflow.outcome.errors.push('Account is already linked to a different user.');
                return workflow.emit('response');
            }

            workflow.account = account;
            workflow.emit('duplicateLinkCheck');
        });
    });

    workflow.on('duplicateLinkCheck', function(callback) {
        req.app.db.models.User.findOne({
            'roles.account': req.body.newAccountId,
            _id: {
                $ne: req.params.id
            }
        }).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (user) {
                workflow.outcome.errors.push('Another user is already linked to that account.');
                return workflow.emit('response');
            }

            workflow.emit('patchUser');
        });
    });

    workflow.on('patchUser', function(callback) {
        req.app.db.models.User.findById(req.params.id).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            user.roles.account = req.body.newAccountId;
            user.save(function(err, user) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                user.populate('roles.admin roles.account', 'name.full', function(err, user) {
                    if (err) {
                        return workflow.emit('exception', err);
                    }

                    workflow.outcome.user = user;
                    workflow.emit('patchAccount');
                });
            });
        });
    });

    workflow.on('patchAccount', function() {
        workflow.account.user = {
            id: req.params.id,
            name: workflow.outcome.user.username
        };
        workflow.account.save(function(err, account) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

exports.unlinkAccount = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not unlink users from accounts.');
            return workflow.emit('response');
        }

        workflow.emit('patchUser');
    });

    workflow.on('patchUser', function() {
        req.app.db.models.User.findById(req.params.id).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!user) {
                workflow.outcome.errors.push('User was not found.');
                return workflow.emit('response');
            }

            var accountId = user.roles.account;
            user.roles.account = null;
            user.save(function(err, user) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                user.populate('roles.admin roles.account', 'name.full', function(err, user) {
                    if (err) {
                        return workflow.emit('exception', err);
                    }

                    workflow.outcome.user = user;
                    workflow.emit('patchAccount', accountId);
                });
            });
        });
    });

    workflow.on('patchAccount', function(id) {
        req.app.db.models.Account.findById(id).exec(function(err, account) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!account) {
                workflow.outcome.errors.push('Account was not found.');
                return workflow.emit('response');
            }

            account.user = undefined;
            account.save(function(err, account) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                workflow.emit('response');
            });
        });
    });

    workflow.emit('validate');
};

exports.delete = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (req.user._id === req.params.id) {
            workflow.outcome.errors.push('You may not delete yourself from user.');
            return workflow.emit('response');
        }

        workflow.emit('deleteUser');
    });

    workflow.on('deleteUser', function(err) {
        req.app.db.User.findById(req.params.id)
        .then(user => {
            return Promise.all([
               user,
               user.setActiveRegions([])
            ]);
        }).then(function([user]) {
            return user.destroy();
        }).then(() => {
            workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

