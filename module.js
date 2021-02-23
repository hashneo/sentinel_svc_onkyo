'use strict';
require('array.prototype.find');

function _module(config) {

    if ( !(this instanceof _module) ){
        return new _module(config);
    }

    const redis = require('redis');
    const moment = require('moment');
    const logger = require('sentinel-common').logger;
    const equals = require('deep-equal');

    const OnkyoDiscover = require('onkyo.js').OnkyoDiscover;
    const onkyoDiscover = new OnkyoDiscover();

    let pub = redis.createClient(
        {
            host: process.env.REDIS || global.config.redis || '127.0.0.1' ,
            socket_keepalive: true,
            retry_unfulfilled_commands: true
        }
    );

    pub.on('end', function(e){
        logger.info('Redis hung up, committing suicide');
        process.exit(1);
    });

    const NodeCache = require( "node-cache" );

    let deviceCache = new NodeCache();
    let statusCache = new NodeCache();

    let merge = require('deepmerge');

    deviceCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: global.moduleName, id : key, value : value });
        logger.info( 'sentinel.device.insert => ' + data );
        pub.publish( 'sentinel.device.insert', data);
    });

    deviceCache.on( 'delete', function( key ){
        let data = JSON.stringify( { module: global.moduleName, id : key });
        logger.info( 'sentinel.device.delete => ' + data );
        pub.publish( 'sentinel.device.delete', data);
    });

    statusCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: global.moduleName, id : key, value : value });
        logger.debug( 'sentinel.device.update => ' + data );
        pub.publish( 'sentinel.device.update', data);
    });

	let that = this;

    onkyoDiscover.discover();

    function processDevice( d ){
        let device = { 'current' : {} };
        device['name'] = d.name;
        device['id'] = d.info.identifier;
        device['type'] = 'multimedia.avr';
        return device;
    }

    function queryState(d){

        return new Promise( (fulfill, reject) =>{
            let state = {};

            d.isOn()
                .then( (result) =>{
                    state.on = result;
                    return d.getVolume()
                })
                .then( (result) =>{
                    state.volume = result;
                    return d.getMute()
                })
                .then( (result) =>{
                    state.mute = result;
                    return d.getSource()
                })
                .then( (result) =>{
                    state.source = result;
                    return d.getSoundMode()
                })
                .then( (result) =>{
                    state.soundMode = result;
                    fulfill(state);
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    function setVariable( id , v ){
        that.getDeviceStatus(id)
            .then( (status) => {
                status = merge( status, v );
                statusCache.set( id, status );
            })
            .catch( (err) =>{
                if (err.errorcode !== 'ENOTFOUND')
                    logger.error(err);
            })
    }

    onkyoDiscover.on('detected', (d) => {

        let device = processDevice(d.device);
        device._device = d;
        deviceCache.set(device.id, device);

        // power
        d.on('PWR', (value) =>{
            setVariable ( device.id, { on : value.PWR }  );
        });

        // sound mode
        d.on('LMD', (value) =>{
            setVariable ( device.id, { soundMode : value.LMD }  );
        });

        //mute
        d.on('AMT', (value) =>{
            setVariable ( device.id, { mute : value.AMT }  );
        });

        // volume
        d.on('MVL', (value) =>{
            setVariable ( device.id, { volume : value.MVL }  );
        });

        // source
        d.on('SLI', (value) =>{
            setVariable ( device.id, { source : value.SLI }  );
        });

        queryState(device._device)
            .then( (state) => {
                statusCache.set(device.id, state);
            })
            .catch( (err) =>{
                logger.error(err);
            });
    });

    onkyoDiscover.on('error', (err) => {

    });

    this.setPowerState = (id, state) => {

        return new Promise( (fulfill, reject) => {

            this.getDevice(id)
                .then( (device) =>{

                    let p;

                    if ( state === 'on' ) {
                        p = device._device.powerOn;
                    } else {
                        p = device._device.powerOff;
                    }

                    p()
                        .then(()=>{
                            fulfill();
                        })
                        .catch ( (err) =>{
                            logger.error(err);
                            reject(err);
                        })

                })
                .catch( (err) => {
                    reject({code: '404', message: 'not found'});
                });
        });

    };

    this.getDevices = () => {

        return new Promise( (fulfill, reject) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                deviceCache.mget( ids, (err,values) =>{
                    if (err)
                        return reject(err);

                    statusCache.mget( ids, (err, statuses) => {
                        if (err)
                            return reject(err);

                        let data = [];

                        for (let key in values) {
                            let v = values[key];

                            if ( statuses[key] ) {
                                v.current = statuses[key];
                                data.push(v);
                            }
                        }

                        fulfill(data);
                    });

                });
            });
        });
    };

    this.getDevice = (id) => {

        return new Promise( (fulfill, reject) => {
            try {
                deviceCache.get(id, (err, value) => {
                    if (err)
                        return reject(err);

                    fulfill(value);
                }, true);
            }catch(err){
                reject(err);
            }
        });

    };

    this.getDeviceStatus = (id) => {

        return new Promise( (fulfill, reject) => {
            try {
                statusCache.get(id, (err, value) => {
                    if (err)
                        return reject(err);

                    fulfill(value);
                }, true);
            }catch(err){
                reject(err);
            }
        });

    };

    function updateStatus() {
        return new Promise( ( fulfill, reject ) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                for ( let i in ids ){
                    let id = ids[i];
                    deviceCache.get( id, (err, device) =>{
                        if (err)
                            return reject(err);

                        let currentState;

                        that.getDeviceStatus( device.id )
                            .then( (state) => {
                                currentState = state;
                                return queryState(device._device);
                            })
                            .then( (state) => {
                                if (!equals( currentState, state )){
                                    statusCache.set(device.id, state);
                                }
                                fulfill();
                            })
                            .catch((err) =>{
                                reject(err);
                            });
                    })
                }
            });
        });
    }

    this.Reload = () => {
        return new Promise( (fulfill,reject) => {
            fulfill([]);
        });
    };

    function loadSystem(){
        return new Promise( ( fulfill, reject ) => {
            fulfill([]);
        });
    }

    loadSystem()

        .then( () => {

            function pollSystem() {
                updateStatus()
                    .then(() => {
                        setTimeout(pollSystem, 1000);
                    })
                    .catch((err) => {
                        logger.error(err);
                        setTimeout(pollSystem, 60000);
                    });

            }

            //setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            logger.error(err);
            process.exit(1);
        });

    return this;
}

module.exports = _module;
