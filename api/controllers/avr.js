'use strict';

module.exports.setPower = (req, res) => {

    let id = req.swagger.params.id.value;
    let state = req.swagger.params.state.value;

    global.module.setPowerState( id, state )
        .then( (data) => {
            res.json( { data: data, result : 'ok'  } );
        })
        .catch( (err) => {
            res.status(err.code >= 400 && err.code <= 451 ? err.code : 500).json( { code: err.code || 0, message: err.message } );
        });
};

