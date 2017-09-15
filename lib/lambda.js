'use strict';

const _ = require('lodash');
const async = require('async');
const traverse = require("traverse");
const path = require('path');
const fs = require('fs');

const exec = require('child_process').exec;

var AWS = require('aws-sdk');
var lambda;

var init = function(input) {
    if (!lambda) {
        if (input.params.profile) {
            console.log('Setting AWS profile: '+input.params.profile);
            var credentials = new AWS.SharedIniFileCredentials({profile: input.params.profile});
            AWS.config.credentials = credentials;
        }
        lambda = new AWS.Lambda();
    }
};

var functions = {};

functions.resolve_stack_params = function(input, done) {
    try {
        traverse(input.stack).forEach(function (obj) {
            if (!_.isNil(obj) && _.isString(obj) && _.includes(obj, '${')) {
                var compiled = _.template(obj);
                try {
                    this.update(compiled(input.stack));
                } catch (err) {
                    throw err;
                }
            }
        });
        done(null, input);
    } catch (err) {
        done(err, input);
    }
};

functions.parse_commands = function(input, phase) {
    var commands = [];
    if (input.stack.deploy.phases) {
        if (input.stack.deploy.phases[phase] && input.stack.deploy.phases[phase].commands &&
            !_.isEmpty(input.stack.deploy.phases[phase].commands)) {
            input.stack.deploy.phases[phase].commands = _.map(input.stack.deploy.phases[phase].commands, function(str) {
                if (_.startsWith(str, 'aws') && !_.includes(str, '--profile') && input.params.profile) {
                    return str + ' --profile '+input.params.profile;
                } else {
                    return str;
                }
            });
            commands = commands.concat(input.stack.deploy.phases[phase].commands);
        }
    }
    return commands;
};

functions.process_commands = function(input, phase, done) {
    var commands = functions.parse_commands(input, phase);
    console.log(phase+' phase');
    async.eachSeries(commands, function(command, next) {
        exec(command, {cwd: path.dirname(input.stack._cim.file) }, function(err, stdout, stderr) {
            process.stdout.write('.');
            next(err);
        });
    }, function(err) {
        console.log('');
        done(err, input);
    });
};

functions.deploy_function = function(function_obj, done) {
    fs.readFile(function_obj.zip_file, function (err, data) {
        if (err) {
            throw err;
        }
        var base64data = new Buffer(data, 'binary');
        var params = {
            FunctionName: function_obj.function_name, /* required */
            DryRun: false,
            Publish: true,
            ZipFile: base64data
        };
        console.log('deploy function: '+function_obj.function_name);
        lambda.updateFunctionCode(params, done);
    });
};

functions.deploy_phase = function(input, done) {
    console.log('deploy phase');
    if (input.stack.deploy.phases.deploy.functions && _.isArray(input.stack.deploy.phases.deploy.functions) &&
        !_.isEmpty(input.stack.deploy.phases.deploy.functions)) {
        async.eachSeries(input.stack.deploy.phases.deploy.functions, function (function_obj, next) {
            function_obj.zip_file = path.resolve(path.dirname(input.stack._cim.file), function_obj.zip_file);
            functions.deploy_function(function_obj, next);
        }, function (err) {
            done(err, input);
        });
    } else {
        done(null, input);
    }
};

functions.deploy = function(input, done) {
    init(input);
    if (input.stack.deploy && _.isEqual(input.params.deploy, 'true')) {
        console.log('Deploying');
        async.waterfall([
            async.constant(input),
            functions.resolve_stack_params,
            async.constant(input, 'pre_deploy'),
            functions.process_commands,
            functions.deploy_phase,
            async.constant(input, 'post_deploy'),
            functions.process_commands
        ], done);
    } else {
        done(null, input);
    }
};

functions.deploy_stacks = function(input, done) {
    async.eachSeries(input.stacks, function(stack, next) {
        functions.deploy({stack: stack, params: input.params}, next);
    }, function(err) {
        done(err, input);
    });
};

module.exports = functions;