'use strict';
var _ = require('underscore');
var json2csv = require('json2csv');
var moment = require('moment');
var sequelize = require('sequelize');

exports.find = function(req, res, next) {
    if (_.isUndefined(req.query.page)) {
        req.query.page = 1;
    }
    if (_.isUndefined(req.query.limit)) {
        req.query.limit  = 20;
    }
    var outcome = {
        data: null,
        pages: {
            current: parseInt(req.query.page, null),
            prev: 0,
            hasPrev: false,
            next: 0,
            hasNext: false,
            total: 0
        },
        items: {
            begin: ((req.query.page * req.query.limit) - req.query.limit) + 1,
            end: req.query.page * req.query.limit,
            total: 0
        }
    };
    var countResults = function(callback) {
        var filters = getFilters().then( function(filters) {
            var regions = filters.regions;
            delete filters.regions;
            req.app.db.Request.count( {
              where: filters,
              include: [
                req.app.db.RequestDuplicate,
                { model: req.app.db.SelectedCounties,
                  include: [
                    { model: req.app.db.chapter,
                      include: [
                        { model: req.app.db.activeRegion,
                          where: { rc_region: regions } }
                      ] }
                  ]
                }
              ]
            }).then(function(results) {
                outcome.items.total = results;
                callback(null, 'done counting');
            });
        });
    };

    var queryUsableRegions = function() {
        var loggedin_id = String(req.user.id);
        var usableRegions =  req.app.db.activeRegion.findAll({
            attributes: ['rc_region', 'region_name'],
            include: [{ model: req.app.db.regionPermission, where: {user_id: loggedin_id } }],
            where: {is_active: true},
            order: 'region_name'
        });
        return usableRegions;
    };

    /*
     * Return promise object, then return filter object based on request
     * data from global req.query, suitable for passing to sequelize functions
     */
    var getFilters = function() {
        var filters = {};
        req.query.search = req.query.search ? req.query.search : '';
        req.query.limit = req.query.limit ? parseInt(req.query.limit, null) : 20;
        req.query.page = req.query.page ? parseInt(req.query.page, null) : 1;
        req.query.sort = req.query.sort ? req.query.sort : '-createdAt';
        req.query.offset = (req.query.page - 1) * req.query.limit;
        req.query.startDate = (req.query.startDate) ? moment(req.query.startDate): '';
        req.query.endDate = (req.query.endDate) ? moment(req.query.endDate) : '';
        req.query.format = (req.query.format) ? req.query.format : 'json';

        if (req.query.startDate != '' && req.query.endDate != '') {
            filters.createdAt = {
                $between:[req.query.startDate.format(), moment(req.query.endDate).endOf("day").format()]
            };
        }
        else {
            if (req.query.startDate != '') {
                filters.createdAt = {
                    gte:req.query.startDate.format()
                };
            }
            else if (req.query.endDate != '') {
                filters.createdAt = {
                    lte:moment(req.query.endDate).endOf("day").format()
                };
            }
        }
        if (req.query.status && req.query.status != 'all') {
            filters.status = req.query.status;
        }
        if (req.query.search) {
            filters.name = {
                $ilike: '%' + req.query.search + '%'
            };
        }

        if (req.query.region) {
            filters.regions = req.query.region
        }
        return queryUsableRegions().then( function (usableRegions) {
            // find intersection of allowed and filtered regions and set
            // that as our filter
            // On first load, filters.regions will be
            // undefined.  For a query with no regions checked,
            // filters.regions will be an empty array
            var entered_regions = filters.regions;
            var allowed_regions = [];
            usableRegions.forEach( function (region) {
                allowed_regions.push(region.rc_region);
            });
            // if they are allowed to see any regions and have filtered
            // on a region
            if (allowed_regions.length > 0 && entered_regions) {
                // check if they're allowed to filter on that region
                var i = 0;
                entered_regions.forEach( function (filteredRegion) {
                    // TODO: does indexOf work in all browsers?
                    if (allowed_regions.indexOf(filteredRegion) < 0) {
                        // pop the disallowed region from the filter
                        entered_regions.splice(i, 1);
                    }
                    i++;
                });
                filters.regions = entered_regions;
            }
            // else if they are allowed to see any regions but haven't
            // filtered, because this is the first page load
            else if (allowed_regions.length > 0 && ! entered_regions) {
                filters.regions = allowed_regions;
            }
            // otherwise they don't have access to any regions and
            // should not get any results.
            else {
                filters.regions = [];
            }
            return filters;
    });
}
var getResults = function(callback) {
    var filters = getFilters().then( function(filters) {
        // Determine direction for order
        var sortOrder = (req.query.sort[0] === '-')? 'DESC' : 'ASC';
        var limit;
        var offset;
        if (req.query.format == 'csv') {
            limit = null;
            offset = null;
        }
        else {
            limit = req.query.limit;
            offset = req.query.offset;
        }

        // This is bit strange, but based on some legacy code, where
        // the region was on the request field, so the filters acted
        // on that, but it had to later be moved into the join.  The
        // code was a little complex to untangle and refactor, so that
        // is to be left for a later day.
        var regions = filters.regions;
        delete filters.regions;
        // Determine whether to filter by date
        req.app.db.Request.findAll({
            where: filters,
            order: [[req.query.sort.replace('-',''), sortOrder ]],
            include: [
              req.app.db.RequestDuplicate,
              { model: req.app.db.SelectedCounties,
                required: true,
                include: [
                  { model: req.app.db.chapter,
                    required: true,
                    include: [
                      { model: req.app.db.activeRegion,
                        required: true,
                        where: { rc_region: regions } }
                    ] }
                ]
              }
            ],
            limit: limit,
            offset: offset
        }).then( function (results_array) {
            outcome.data = results_array;
            outcome.pages.total = Math.ceil(outcome.items.total / req.query.limit);
            outcome.pages.next = ((outcome.pages.current + 1) > outcome.pages.total ? 0 : outcome.pages.current + 1);
            outcome.pages.hasNext = (outcome.pages.next !== 0);
            outcome.pages.prev = outcome.pages.current - 1;
            outcome.pages.hasPrev = (outcome.pages.prev !== 0);
            if (outcome.items.end > outcome.items.total) {
                outcome.items.end = outcome.items.total;
            }

            outcome.results = results_array.map(function(result) {
              var duplicateCount = result.RequestDuplicates.length;
              result = result.toJSON();
              result.duplicate_count = duplicateCount;
              return result;
            });
            return callback(null, 'done');
        }).catch(function(err) {
            console.log("ERROR calling callback: " + err);
            return callback(err, null);
        });
    }); };

    var createCSV = function() {
        var fields = [
          'status',
          { label: 'id', value: 'public_id' },
          'name',
          'address',
          'city',
          'state',
          'zip',
          'phone',
          'email',
          { label: 'date created', value: 'createdAt' },
          { label: 'date updated', value: 'updatedAt' },
          { label: 'county', value: 'SelectedCounty.county' },
          { label: 'chapter', value: 'SelectedCounty.chapter.name' },
          { label: 'region', value: 'SelectedCounty.chapter.activeRegion.region_name' },
          'source',
          { label: 'count duplicates', value: 'duplicate_count' }
        ]
        var parser = new json2csv.Parser({ fields });
        var csv = parser.parse(outcome.results);
        res.setHeader('Content-Type','application/csv');
        res.setHeader('Content-Disposition','attachment; filename=smoke-alarm-requests-' + moment().format() + '.csv;');
        res.send(csv);
    }

    var asyncFinally = function(err, results) {
        if (err) {
            return next(err);
        }

        // TODO: This section has duplicated logic which can be removed
        // For some reason, after using a filter, Backbone treats all links
        // as XHR requests, even if they're not. This works around the
        // issue for now, but should be fixed moving forward
        outcome.filters = req.query;
        if (req.xhr) {
            if (req.query.format !== "csv") {
                res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.send(outcome);
            } else {
                createCSV();
            }
        } else {
            return queryUsableRegions().then( function (regions) {
                console.log(regions.map(region => region.rc_region));
                //get list of all regions
                outcome.results.filters = req.query;
                if (req.query.format !== "csv") {
                    res.render('admin/requests/index', {
                        data: {
                            csrfToken: res.locals.csrfToken,
                            results: escape(JSON.stringify(outcome)),
                            usable_regions: regions
                        }
                    });
                } else {
                    createCSV();
                }
            });
        }
    };
    require('async').parallel([countResults, getResults], asyncFinally);
};

exports.unknown = function(req, res, next) {
    if (_.isUndefined(req.query.page)) {
        req.query.page = 1;
    }
    if (_.isUndefined(req.query.limit)) {
        req.query.limit  = 20;
    }
    var outcome = {
        data: null,
        pages: {
            current: parseInt(req.query.page, null),
            prev: 0,
            hasPrev: false,
            next: 0,
            hasNext: false,
            total: 0
        },
        items: {
            begin: ((req.query.page * req.query.limit) - req.query.limit) + 1,
            end: req.query.page * req.query.limit,
            total: 0
        }
    };
    var countResults = function(callback) {
        var filters = getFilters()
        req.app.db.Request.count( {
          where: filters
        }).then(function(results) {
            outcome.items.total = results;
            callback(null, 'done counting');
        });
    };

    /*
     * Return promise object, then return filter object based on request
     * data from global req.query, suitable for passing to sequelize functions
     */
    var getFilters = function() {
        var filters = { selected_county: null};
        req.query.search = req.query.search ? req.query.search : '';
        req.query.limit = req.query.limit ? parseInt(req.query.limit, null) : 20;
        req.query.page = req.query.page ? parseInt(req.query.page, null) : 1;
        req.query.sort = req.query.sort ? req.query.sort : '-createdAt';
        req.query.offset = (req.query.page - 1) * req.query.limit;
        req.query.startDate = (req.query.startDate) ? moment(req.query.startDate): '';
        req.query.endDate = (req.query.endDate) ? moment(req.query.endDate) : '';
        req.query.format = (req.query.format) ? req.query.format : 'json';

        if (req.query.startDate != '' && req.query.endDate != '') {
            filters.createdAt = {
                $between:[req.query.startDate.format(), moment(req.query.endDate).endOf("day").format()]
            };
        }
        else {
            if (req.query.startDate != '') {
                filters.createdAt = {
                    gte:req.query.startDate.format()
                };
            }
            else if (req.query.endDate != '') {
                filters.createdAt = {
                    lte:moment(req.query.endDate).endOf("day").format()
                };
            }
        }
        if (req.query.status && req.query.status != 'all') {
            filters.status = req.query.status;
        }
        if (req.query.search) {
            filters.name = {
                $ilike: '%' + req.query.search + '%'
            };
        }

        return filters;
    };

    var getResults = function(callback) {
        var filters = getFilters();
        // Determine direction for order
        var sortOrder = (req.query.sort[0] === '-')? 'DESC' : 'ASC';
        var limit;
        var offset;
        if (req.query.format == 'csv') {
            limit = null;
            offset = null;
        }
        else {
            limit = req.query.limit;
            offset = req.query.offset;
        }

        // Determine whether to filter by date
        req.app.db.Request.findAll({
            where: filters,
            order: [[req.query.sort.replace('-',''), sortOrder ]],
            limit: limit,
            include: [req.app.db.RequestDuplicate],
            offset: offset
        }).then( function (results_array) {
            outcome.data = results_array;
            outcome.pages.total = Math.ceil(outcome.items.total / req.query.limit);
            outcome.pages.next = ((outcome.pages.current + 1) > outcome.pages.total ? 0 : outcome.pages.current + 1);
            outcome.pages.hasNext = (outcome.pages.next !== 0);
            outcome.pages.prev = outcome.pages.current - 1;
            outcome.pages.hasPrev = (outcome.pages.prev !== 0);
            if (outcome.items.end > outcome.items.total) {
                outcome.items.end = outcome.items.total;
            }
            outcome.unknown = true;

            outcome.results = results_array.map(function(result) {
              var duplicateCount = result.RequestDuplicates.length;
              result = result.toJSON();
              result.duplicate_count = duplicateCount;
              return result;
            });
            return callback(null, 'done');
        }).catch(function(err) {
            console.log("ERROR calling callback: " + err);
            return callback(err, null);
        });
    };

    var createCSV = function() {
        var fields = [
          { label: 'id', value: 'public_id' },
          'name',
          'address',
          'city',
          'state',
          'zip',
          'phone',
          'email',
          { label: 'date created', value: 'createdAt' },
          { label: 'date updated', value: 'updatedAt' },
          'source',
          { label: 'count duplicates', value: 'duplicate_count' }
        ]
        var parser = new json2csv.Parser({ fields });
        var csv = parser.parse(outcome.results);
        res.setHeader('Content-Type','application/csv');
        res.setHeader('Content-Disposition','attachment; filename=smoke-alarm-requests-' + moment().format() + '.csv;');
        res.send(csv);
    }

    var asyncFinally = function(err, results) {
        if (err) {
            return next(err);
        }

        // TODO: This section has duplicated logic which can be removed
        // For some reason, after using a filter, Backbone treats all links
        // as XHR requests, even if they're not. This works around the
        // issue for now, but should be fixed moving forward
        outcome.filters = req.query;
        if (req.xhr) {
            if (req.query.format !== "csv") {
                res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.send(outcome);
            } else {
                createCSV();
            }
        } else {
            outcome.results.filters = req.query;
            if (req.query.format !== "csv") {
                res.render('admin/requests/index', {
                    data: {
                        csrfToken: res.locals.csrfToken,
                        results: escape(JSON.stringify(outcome))
                    }
                });
            } else {
                createCSV();
            }
        }
    };
    require('async').parallel([countResults, getResults], asyncFinally);
};


exports.read = function(req, res, next) {
    var outcome = {};

    var getRecord = function(callback) {
        req.app.db.models.Request.findById(req.params.id).exec(function(err, record) {
            if (err) {
                return callback(err, null);
            }

            outcome.record = record;
            return callback(null, 'done');
        });
    };

    var asyncFinally = function(err, results) {
        if (err) {
            return next(err);
        }

        if (req.xhr) {
            res.send(outcome.record);
        } else {
            res.render('admin/requests/details', {
                data: {
                    record: escape(JSON.stringify(outcome.record)),
                    statuses: outcome.statuses
                }
            });
        }
    };

    require('async').parallel([getRecord], asyncFinally);
};

exports.create = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.body['name.full']) {
            workflow.outcome.errors.push('Please enter a name.');
            return workflow.emit('response');
        }

        workflow.emit('createRequest');
    });

    workflow.on('createRequest', function() {
        var nameParts = req.body['name.full'].trim().split(/\s/);
        var fieldsToSet = {
            name: {
                first: nameParts.shift(),
                middle: (nameParts.length > 1 ? nameParts.shift() : ''),
                last: (nameParts.length === 0 ? '' : nameParts.join(' ')),
            },
            userCreated: {
                id: req.user._id,
                name: req.user.username,
                time: new Date().toISOString()
            }
        };
        fieldsToSet.name.full = fieldsToSet.name.first + (fieldsToSet.name.last ? ' ' + fieldsToSet.name.last : '');
        fieldsToSet.search = [
            fieldsToSet.name.first,
            fieldsToSet.name.middle,
            fieldsToSet.name.last
        ];

        req.app.db.models.Request.create(fieldsToSet, function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.outcome.record = Request;
            return workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

exports.update = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (workflow.hasErrors()) {
            return workflow.emit('response');
        }
        workflow.emit('patchRequest');
    });

    workflow.on('patchRequest', function() {
        var fieldsToSet = {
            name: {
                first: req.body.first,
                middle: req.body.middle,
                last: req.body.last,
                full: req.body.first + ' ' + req.body.last
            },
            company: req.body.company,
            phone: req.body.phone,
            zip: req.body.zip,
            search: [
                req.body.name,
                req.body.address,
                req.body.city,
                req.body.state,
                req.body.zip
            ]
        };

        req.app.db.Request.findOne({ where: {id: req.params.id} }).then( function(Request) {
            if (Request) { // if the record exists in the db
                Request.updateAttributes({
                    status: req.body.status
                }).then(function() {
                    workflow.outcome.Request = Request;
                    return workflow.emit('response');
                });
            }
        });
    });

    workflow.emit('validate');
};

exports.linkUser = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not link Requests to users.');
            return workflow.emit('response');
        }

        if (!req.body.newUsername) {
            workflow.outcome.errfor.newUsername = 'required';
            return workflow.emit('response');
        }

        workflow.emit('verifyUser');
    });

    workflow.on('verifyUser', function(callback) {
        req.app.db.models.User.findOne({
            username: req.body.newUsername
        }).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!user) {
                workflow.outcome.errors.push('User not found.');
                return workflow.emit('response');
            } else if (user.roles && user.roles.Request && user.roles.Request !== req.params.id) {
                workflow.outcome.errors.push('User is already linked to a different Request.');
                return workflow.emit('response');
            }

            workflow.user = user;
            workflow.emit('duplicateLinkCheck');
        });
    });

    workflow.on('duplicateLinkCheck', function(callback) {
        req.app.db.models.Request.findOne({
            'user.id': workflow.user._id,
            _id: {
                $ne: req.params.id
            }
        }).exec(function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (Request) {
                workflow.outcome.errors.push('Another Request is already linked to that user.');
                return workflow.emit('response');
            }

            workflow.emit('patchUser');
        });
    });

    workflow.on('patchUser', function() {
        req.app.db.models.User.findByIdAndUpdate(workflow.user._id, {
            'roles.Request': req.params.id
        }).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.emit('patchRequest');
        });
    });

    workflow.on('patchRequest', function(callback) {
        req.app.db.models.Request.findByIdAndUpdate(req.params.id, {
            user: {
                id: workflow.user._id,
                name: workflow.user.username
            }
        }).exec(function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.outcome.Request = Request;
            workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

exports.unlinkUser = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not unlink users from Requests.');
            return workflow.emit('response');
        }

        workflow.emit('patchRequest');
    });

    workflow.on('patchRequest', function() {
        req.app.db.models.Request.findById(req.params.id).exec(function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!Request) {
                workflow.outcome.errors.push('Request was not found.');
                return workflow.emit('response');
            }

            var userId = Request.user.id;
            Request.user = {
                id: undefined,
                name: ''
            };
            Request.save(function(err, Request) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                workflow.outcome.Request = Request;
                workflow.emit('patchUser', userId);
            });
        });
    });

    workflow.on('patchUser', function(id) {
        req.app.db.models.User.findById(id).exec(function(err, user) {
            if (err) {
                return workflow.emit('exception', err);
            }

            if (!user) {
                workflow.outcome.errors.push('User was not found.');
                return workflow.emit('response');
            }

            user.roles.Request = undefined;
            user.save(function(err, user) {
                if (err) {
                    return workflow.emit('exception', err);
                }

                workflow.emit('response');
            });
        });
    });

    workflow.emit('validate');
};

exports.newNote = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.body.data) {
            workflow.outcome.errors.push('Data is required.');
            return workflow.emit('response');
        }

        workflow.emit('addNote');
    });

    workflow.on('addNote', function() {
        var noteToAdd = {
            data: req.body.data,
            userCreated: {
                id: req.user._id,
                name: req.user.username,
                time: new Date().toISOString()
            }
        };

        req.app.db.models.Request.findByIdAndUpdate(req.params.id, {
            $push: {
                notes: noteToAdd
            }
        }, function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.outcome.Request = Request;
            return workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

exports.newStatus = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.body.id) {
            workflow.outcome.errors.push('Please choose a status.');
        }

        if (workflow.hasErrors()) {
            return workflow.emit('response');
        }

        workflow.emit('addStatus');
    });

    workflow.on('addStatus', function() {
        var statusToAdd = {
            id: req.body.id,
            name: req.body.name,
            userCreated: {
                id: req.user._id,
                name: req.user.username,
                time: new Date().toISOString()
            }
        };

        req.app.db.models.Request.findByIdAndUpdate(req.params.id, {
            status: statusToAdd,
            $push: {
                statusLog: statusToAdd
            }
        }, function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.outcome.Request = Request;
            return workflow.emit('response');
        });
    });

    workflow.emit('validate');
};

exports.delete = function(req, res, next) {
    var workflow = req.app.utility.workflow(req, res);

    workflow.on('validate', function() {
        if (!req.user.roles.admin.isMemberOf('root')) {
            workflow.outcome.errors.push('You may not delete Requests.');
            return workflow.emit('response');
        }

        workflow.emit('deleteRequest');
    });

    workflow.on('deleteRequest', function(err) {
        req.app.db.models.Request.findByIdAndRemove(req.params.id, function(err, Request) {
            if (err) {
                return workflow.emit('exception', err);
            }

            workflow.outcome.Request = Request;
            workflow.emit('response');
        });
    });

    workflow.emit('validate');
};
