var db = require('../models');
var axios = require('axios');
var config = require('../config');
var requestData = {};

// Config for Google Maps Geocode API
var mapsApiUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
var mapsApiKey = config.googleMapsApiKey;

var state_abbrevs =
    {
        "Alabama":                        "AL",
        "Alaska":                         "AK",
        "Arizona":                        "AZ",
        "Arkansas":                       "AR",
        "California":                     "CA",
        "Colorado":                       "CO",
        "Connecticut":                    "CT",
        "Delaware":                       "DE",
        "Florida":                        "FL",
        "Georgia":                        "GA",
        "Hawaii":                         "HI",
        "Idaho":                          "ID",
        "Illinois":                       "IL",
        "Indiana":                        "IN",
        "Iowa":                           "IA",
        "Kansas":                         "KS",
        "Kentucky":                       "KY",
        "Louisiana":                      "LA",
        "Maine":                          "ME",
        "Maryland":                       "MD",
        "Massachusetts":                  "MA",
        "Michigan":                       "MI",
        "Minnesota":                      "MN",
        "Mississippi":                    "MS",
        "Missouri":                       "MO",
        "Montana":                        "MT",
        "Nebraska":                       "NE",
        "Nevada":                         "NV",
        "New Hampshire":                  "NH",
        "New Jersey":                     "NJ",
        "New Mexico":                     "NM",
        "New York":                       "NY",
        "North Carolina":                 "NC",
        "North Dakota":                   "ND",
        "Ohio":                           "OH",
        "Oklahoma":                       "OK",
        "Oregon":                         "OR",
        "Pennsylvania":                   "PA",
        "Rhode Island":                   "RI",
        "South Carolina":                 "SC",
        "South Dakota":                   "SD",
        "Tennessee":                      "TN",
        "Texas":                          "TX",
        "Utah":                           "UT",
        "Vermont":                        "VT",
        "Virginia":                       "VA",
        "Washington":                     "WA",
        "West Virginia":                  "WV",
        "Wisconsin":                      "WI",
        "Wyoming":                        "WY",
        "American Samoa":                 "AS",
        "District of Columbia":           "DC",
        "Federated States of Micronesia": "FM",
        "Guam":                           "GU",
        "Marshall Islands":               "MH",
        "Northern Mariana Islands":       "MP",
        "Palau":                          "PW",
        "Puerto Rico":                    "PR",
        "Virgin Islands":                 "VI",
        "Armed Forces Africa":            "AE",
        "Armed Forces Americas":          "AA",
        "Armed Forces Canada":            "AE",
        "Armed Forces Europe":            "AE",
        "Armed Forces Middle East":       "AE",
        "Armed Forces Pacific":           "AP"
    };

module.exports  = {

    // get count of requests saved for a given region
    countRequestsPerRegion: function (region) {
        if (region){
            return db.Request.count({
                include: [
                    { model: db.SelectedCounties,
                      include: [
                        { model: db.chapter,
                          include: [
                            { model: db.activeRegion,
                              where: { rc_region: region } }
                          ] }
                      ]
                    }
                  ]
            });
        }
        else {
            return db.Request.count({
                where: {
                    SelectedCounty: null
                }
            });
        }
    },

    // takes a "value" that needs to be a certain "length" (in this file,
    // either a date or a sequence number) and pads it with leading zeroes
    // until it is "length" long.
    padWithZeroes: function (value, length){
        while (value.length < length) {
            value = "0" + value;
        }
        return value;
    },

    findZipForLookup: function (req) {
        // get zip_for_lookup from req
        // Treat zip code specially.  For zip codes, we remove all
        // internal spaces, since they can't possibly be useful.
        var requestZip = {};
        // may be called from sms or website:
        if (req.body.zip) {
            requestZip.zip_received = req.body.zip.trim().replace(/\s+/g, '');
        }
        else if (req.query.Body) {
            requestZip.zip_received = req.query.Body.trim().replace(/\s+/g, '');
        }
        // This is the zip code we will actually store in the database.
        // Our canonical form for storing zip codes is any of the following:
        // "NNNNN" (a 5 digit string), "NNNNN-NNNN" (a string consisting
        // of 5 digits, a hyphen, and 4 digits), or null.  No other forms
        // are to be stored, at least not without changing this comment.
        requestZip.zip_final = null;

        // Parse 5-digit section and optional 4-digit section from the zip code.
        requestZip.zip_5 = null;
        requestZip.zip_4 = null;
        var zip_re = /^([0-9][0-9][0-9][0-9][0-9]) *[-_+]{0,1} *([0-9][0-9][0-9][0-9]){0,1}$/g;
        requestZip.zip_match = zip_re.exec(requestZip.zip_received);
        if (requestZip.zip_match) {
            if (requestZip.zip_match.length < 2) {
                console.log("ERROR: zip matched, but match grouping is somehow wrong,");
                console.log("       which implies that the regexp itself is not right");
                console.log("       (or our use of it isn't right).");
            }
            else {
                requestZip.zip_5 = requestZip.zip_match[1];
                if (requestZip.zip_match.length == 3 && requestZip.zip_match[2] !== undefined) {
                    requestZip.zip_4 = requestZip.zip_match[2];
                    requestZip.zip_final = requestZip.zip_5 + "-" + requestZip.zip_4;
                } else {
                    requestZip.zip_final = requestZip.zip_5;
                }
            }
        }

        requestZip.zip_for_lookup = requestZip.zip_5;
        if (! requestZip.zip_for_lookup) {
            // If the zip we got doesn't look like it was a real zip, then
            // it won't work later as a key for database lookups.  But we
            // should still pass it along so at least error messages can
            // display it accurately.
            requestZip.zip_for_lookup = requestZip.zip_received;
        }
        
        return requestZip;
    },

    getRequestData: function(req, numberOfRequests) {
        var zipArray = module.exports.findZipForLookup(req);
        requestData.zip_for_lookup = zipArray.zip_for_lookup;
        requestData.zip_final = zipArray.zip_final;
        // Things we derive from the user-provided zip code.
        var stateFromZip = null;   // remains null if no match
        var countyFromZip = null;  // remains null if no match

        // Treat state gingerly.  Because of the way ../views/index.js
        // simulates placeholder text for State, there is a possibility
        // that, unlike other fields, req.body.state may be undefined.
        // For other fields we can assume they are strings, either empty
        // or non-empty, so here we make state meet that assumption too.
        if (req.body.state === undefined) {
            req.body.state = '';
        }
        // Trim and sanitize the request values.
        //
        // Note: we could augment String like so
        //
        //     String.prototype.trimAndSlim() {
        //         return this.trim().replace(/\s+/g, ' ');
        //     };
        //
        // and use that to declutter the code below.  But I'm not sure
        // whether such augmentation is frowned on or not.  Advice from
        // more experienced Javascript programmers welcome.  -Karl
        requestData.name = req.body.name.trim().replace(/\s+/g, ' ');
        requestData.street_address = req.body.street_address.trim().replace(/\s+/g, ' ');
        requestData.city = req.body.city.trim().replace(/\s+/g, ' ');
        requestData.state = req.body.state.trim().replace(/\s+/g, ' ');
        requestData.phone = req.body.phone.trim().replace(/\s+/g, ' ');
        requestData.email = req.body.email.trim().replace(/\s+/g, ' ');

        return requestData;
    },

    createPublicId: function (numberOfRequests, requestData, region) {
        // construct today date object
        var today = new Date();
        // avoid the first request having a public_id of "region-date-00000."
        // I think that would be confusing for users; we might as well start with 1.
        numberOfRequests = numberOfRequests + 1;
        var sequenceNumber = module.exports.padWithZeroes(numberOfRequests.toString(), 5);
         // find fiscal year
        var fiscalYear = today.getFullYear();
        //account for zero-indexing
        var thisMonth = today.getMonth() + 1;
        if (thisMonth > 6) {
            fiscalYear = fiscalYear + 1;
        }
        var displayedYear = fiscalYear - 2000;
        if (region) {
            var public_id = region + "-" + displayedYear + "-" + sequenceNumber;
        }
        else {
            // construct code from state
            var state_code = "";
            if (requestData.state != "" && state_abbrevs[requestData.state]){
                // get abbreviation
                state_code = "XX" + state_abbrevs[requestData.state];
            }
            else {
                state_code = "XXXX";
            }
            var public_id = state_code + "-" + displayedYear + "-" + sequenceNumber;
        }

        requestData.public_id = public_id;
        return requestData;
    },

    // Searches for any previous request to see if this is a duplicate
    // Returns null if not found, otherwise returns first record
    findPriorRequest: function(requestData) {
      // Replacing non-numeric characters with Postgres match operator, adding 
      // one to the beginning to accommodate country codes
      var phoneQuery = "%" + requestData.phone.replace(/[^0-9]/g, "%");

      return db.Request.findOne({
          where: {
            name: { $ilike: requestData.name },
            address: { $ilike: requestData.street_address },
            city: { $ilike: requestData.city },
            state: { $ilike: requestData.state },
            zip: requestData.zip_final,
            email: { $ilike: requestData.email },
            phone: { $like: phoneQuery },
          },
          order: '"createdAt" DESC'
      });
    },

    // Force update of updatedAt without changing attributes
    // source: https://github.com/sequelize/sequelize/issues/3759
    updateRequestTime: function(request) {
      request.changed('updatedAt', true);
      return request.save();
    },

    // Saves request duplicate, with only parameter being the request ID
    saveRequestDuplicate: function(request) {
      return db.RequestDuplicate.create({ requestId: request.id });
    },

    // Save the request data unconditionally.  Even if we can't
    // service the request -- or even if it contains some invalid
    // data, such as an unknown zip code -- we still want to record
    // that the person made the request.

    // TODO: We need to have sanitized all inputs by now.  We need to
    // know that all input is not problematic from an SQL point of
    // view (even though we're using an ORM here, we don't want to
    // store data that will later be a security risk for someone else
    // generating a report or whatever), and we need to make sure that
    // the email address does not have surrounding "<" and ">", and
    // that the phone number is in a standard 10-digit format
    // (actually, I think we've already validated that, but let's
    // check again here).

    saveRequestData: function(requestData) {
        var savedRequest;
        return db.Request.create({
            name: requestData.name,
            source: requestData.source,
            address: requestData.street_address,
            sms_raw_address: requestData.raw_address,
            city: requestData.city,
            state: requestData.state,
            zip: requestData.zip_final,
            sms_raw_zip: requestData.raw_zip,
            phone: requestData.phone,
            sms_raw_phone: requestData.raw_phone,
            email: requestData.email,
            public_id: requestData.public_id,
            status: 'new'
        }).then(function(request) {
            request.setSelectedCounty(requestData.county);
            savedRequest = request;
            var query = [
                request.address,
                request.city,
                request.state,
                request.zip
            ].join(' ');
            return axios(mapsApiUrl, {
                params: {
                    key: mapsApiKey,
                    address: query
                }
            });
        }).then(function(geocodeResponse) {
            try {
                var loc = geocodeResponse.data.results[0].geometry.location;
                savedRequest.latitude = loc.lat;
                savedRequest.longitude = loc.lng;
            } catch (e) {
                console.log('Location not found in response, NBD.');
            }
            return savedRequest.save();
        }).catch(function (error) {
            console.log(error);
            throw error;
        });
    },

    // Convenience method for checking if a request exists already, updating 
    // the updatedAt column and creating a request duplicate if so, otherwise 
    // create a new request. 
    // Returns a promise resolving to a request
    saveOrDuplicateRequest: function(requestData) {
      return module.exports.findPriorRequest(requestData)
        .then( function(request) {
          // If request is a duplicate, resolve promises for updating request 
          // time and saving a request duplicate. Return the request promise
          if (request !== null) {
            return Promise.all([
              module.exports.updateRequestTime(request),
              module.exports.saveRequestDuplicate(request)
            ]).then( function(updates) {
              return updates[0];
            });
          }
          // If request is not a duplicate, save it and return a promise
          return module.exports.saveRequestData(requestData);
        });
    },

    // This function gets the address from the zip code in the request
    findAddressFromZip: function(zip) {
        return db.UsAddress.findOne({where: {zip: zip}});
    },

    // This function gets the selected county if it exists from the requests
    findCountyFromAddress: function(address, zip) {
        if (!address) {
            // Then no valid zipcode was found, so make sure that the
            // "invalid zip" page is displayed
            requestData.countyFromZip = null;
            requestData.stateFromZip = null;
            // make sure that the correct "zip_for_lookup" is specified here...
            requestData.zip_for_lookup = zip;
            return null;
        } 

        if (address['county']) {
            requestData.countyFromZipDropCounty = address['county'].replace(" County", "");
            requestData.countyFromZip = requestData.countyFromZipDropCounty;
            // Get the version of the county name with no spaces -
            // e.g. "LaSalle" instead of "La Salle".  See #251.
            requestData.countyFromZipNoSpaces = requestData.countyFromZipDropCounty.replace(" ", "");
        }

        requestData.stateFromZip = address['state'];
        return db.SelectedCounties.findOne({
            include: [ db.chapter ],
            where: {
                // Use the PostgreSQL "ILIKE" (case-insensitive LIKE)
                // operator so that internal inconsistencies in the
                // case-ness of our data don't cause problems.  For
                // example, Lac qui Parle County, MN is "Lac qui
                // Parle" (correct) in ../data/selected_counties.json
                // but "Lac Qui Parle" (wrong) in us_addresses.json.
                //
                // Since us_addresses.json comes from an upstream data
                // source, correcting all the cases there could be a
                // maintenance problem.  It's easier just to do our
                // matching case-insensitively.
                //
                // http://docs.sequelizejs.com/en/latest/docs/querying/
                // has more about the use of operators like $ilike.
                state: { $ilike: requestData.stateFromZip },
                $or: [
                    {
                        county: {
                            $ilike: requestData.countyFromZip
                        }
                    },
                    {
                        county: {
                            $ilike: requestData.countyFromZipNoSpaces
                        }
                    }
                ]
            }
        });
    },

    getContacts: function(region) {
        return db.User.findAll({
            where: {isActive: "yes"},
            include: [{
                model: db.activeRegion,
                where: { rc_region: region.rc_region },
                through: {
                    where: { contact: true }
                }
            }]
        });
    },

    // sends an email to the regional representatives
    sendEmail: function(request, selectedRegion) {
        this.getContacts(selectedRegion).then(users => {
            users.map(user => {
                var regionPresentableName = selectedRegion.region_name;
                var regionRecipientName   = user.name;
                var regionRecipientEmail  = user.email;
                var thisRequestID = request.public_id;

                var email_text = "We have received a smoke alarm installation request from:\n"
                    + "\n"
                    + "  " + request.name + "\n"
                    + "  " + request.address + "\n"
                    + "  " + request.city + ", ";
                if (state_abbrevs[request.state]){
                    email_text = email_text + state_abbrevs[request.state];
                }
                else {
                    email_text = email_text + request.state;
                }
                email_text = email_text + "  " + request.zip + "\n";

                if (request.phone) {
                    email_text += "  Phone: " + request.phone + "\n";
                } else {
                    email_text += "  Phone: ---\n";
                };
                if (request.email) {
                    email_text += "  Email: <" + request.email + ">\n";
                } else {
                    email_text += "  Email: ---\n";
                };

                email_text += "\n"
                    + "This is installation request #" + thisRequestID
                    + ".  It was received via " + request.source + ".\n"
                    + "\n"
                    + "We're directing this request to the administrator for the\n"
                    + "ARC North Central Division, " + regionPresentableName + " region:\n"
                    + "\n"
                    + "  " + regionRecipientName + " <" + regionRecipientEmail + ">\n"
                    + "\n"
                    + "Thank you,\n"
                    + "-The Smoke Alarm Request Portal\n";

                // Send an email to the appropriate Red Cross administrator.
                var outbound_email = {
                    from: db.mail_from_addr,
                    to: regionRecipientName + " <" + regionRecipientEmail + ">",
                    subject: "Smoke alarm install request from " 
                        + request.name + " (#" + thisRequestID + ")",
                    text: email_text
                };

                db.mailgun.messages().send(outbound_email, function (error, body) {
                    if (!body) return;

                    // TODO: We need to record the sent message's Message-ID 
                    // (which is body.id) in the database, with the request.
                    if (body.id === undefined) {
                        console.log("DEBUG: sent mail ID was undefined");
                    } else {
                        console.log("DEBUG: sent mail ID:  '" + body.id + "'");
                    }
                    if (body.message === undefined) {
                        console.log("DEBUG: sent mail msg was undefined");
                    } else {
                        console.log("DEBUG: sent mail msg: '" + body.message + "'");
                    }
                });
            });
        });
    }
}
