// Copyright (C) 2020, Jeroen K.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

import * as url from "url";
import * as http from "http";
import * as events from "events";
import * as util from "util";
import md5 from "md5";
// var url = require('url');
// var http = require('http');
// var events = require('events');
// var util = require('util');


function extractBoundary(contentType) {
  contentType = contentType.replace(/\s+/g, '');

  var startIndex = contentType.indexOf('boundary=');
  var endIndex = contentType.indexOf(';', startIndex);
  if (endIndex == -1) { //boundary is the last option
    // some servers, like mjpeg-streamer puts a '\r' character at the end of each line.
    if ((endIndex = contentType.indexOf('\r', startIndex)) == -1) {
      endIndex = contentType.length;
    }
  }
  return contentType.substring(startIndex + 9, endIndex).replace(/"/gi,'').replace(/^\-\-/gi, '');
}


// MjpegProxy Module
export class MjpegProxy {
  constructor(mjpegUrl, user, pass) {
    events.EventEmitter.call(this);

    var self = this;

    if (!mjpegUrl)
      throw new Error('Please provide a source MJPEG URL');

    self.mjpegOptions = url.parse(mjpegUrl);

    self.audienceResponses = [];
    self.newAudienceResponses = [];

    self.boundary = null;
    self.globalMjpegResponse = null;
    self.mjpegRequest = null;

    self.outerRequest = function (req, res) {
        self.emit("streamstart", "[MjpegProxy] Started streaming " + mjpegUrl + " , users: " + (self.audienceResponses.length + 1));

        // There is already another client consuming the MJPEG response
        if (self.mjpegRequest !== null) {

          self._newClient(req, res);
        } else {
          const req = http.request(self.mjpegOptions, (res) => {
            console.log(`STATUS: ${res.statusCode}`);
            console.log(`REQ HEADERS: ${JSON.stringify(self.mjpegOptions.headers)}`);
            console.log(`RES HEADERS: ${JSON.stringify(res.headers)}`);
            
            if (res.statusCode == 401) {
              self.mjpegOptions.headers = {};
              let cnonce = md5(String(new Date().getTime()));
              let auth = res.headers["www-authenticate"];
              let realm, nonce, qop;
              let authSplit = auth.split(",");
              
              for (let item of authSplit) {
                if (item.indexOf("realm=") >= 0) {
                  let realmSplit = item.split("=\"");
                  realm = realmSplit[realmSplit.length - 1];
                  realm = realm.substring(0, realm.length - 1);
                }
                
                if (item.indexOf("nonce=") >= 0) {
                  let nonceSplit = item.split("=\"");
                  nonce = nonceSplit[nonceSplit.length - 1];
                  nonce = nonce.substring(0, nonce.length - 1);
                }
                
                if (item.indexOf("qop=") >= 0) {
                  let qopSplit = item.split("=\"");
                  qop = qopSplit[qopSplit.length - 1];
                  qop = qop.substring(0, qop.length - 1);
                }
              }			
                    
              let HA1 = md5(user + ":" + realm + ":" + pass);
              let HA2 = md5(self.mjpegOptions.method + ":" + self.mjpegOptions.path);
              let response = md5(HA1 + ":" + nonce + ":00000001:" + cnonce + ":" + qop + ":" + HA2);
            
              self.mjpegOptions.headers.Authorization = "Digest username=\"" + user + "\",realm=\"" + realm + "\",nonce=\"" + nonce + "\",uri=\"" + self.mjpegOptions.path + "\",cnonce=\"" + cnonce + "\",nc=00000001,algorithm=MD5,response=\"" + response + "\",qop=\"" + qop + "\"";
              self.proxyRequest(self.mjpegOptions, res);
            } else {
              console.error("status code failed!!");
              cb("status code failed!!", null);
              return;
            }
            
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              console.log(`BODY: ${chunk}`);
            });
            res.on('end', () => {
            });
          });
        
          req.on('error', (e) => {
            console.error(`problem with request: ${e.message}`);
          });
          req.end();
        }
    }

    self.proxyRequest = function (req, res) {
      // if (res.socket == null) {
      //   return;
      // }
      // Send source MJPEG request
        self.mjpegRequest = http.request(req, function (mjpegResponse) {
        console.log('request');
        console.log(`STATUS: ${mjpegResponse.statusCode}`);
        console.log(`HEADERS: ${JSON.stringify(mjpegResponse.headers)}`);
        self.globalMjpegResponse = mjpegResponse;
        self.boundary = extractBoundary(mjpegResponse.headers['content-type']);

        self._newClient(req, res);

        var lastByte1 = null;
        var lastByte2 = null;

        mjpegResponse.on('data', function (chunk) {
          // Fix CRLF issue on iOS 6+: boundary should be preceded by CRLF.
          var buff = Buffer.from(chunk);
          if (lastByte1 != null && lastByte2 != null) {
            var oldheader = '--' + self.boundary;

            var p = buff.indexOf(oldheader);

            if (p == 0 && !(lastByte2 == 0x0d && lastByte1 == 0x0a) || p > 1 && !(chunk[p - 2] == 0x0d && chunk[p - 1] == 0x0a)) {
              var b1 = chunk.slice(0, p);
              var b2 = new Buffer('\r\n--' + self.boundary);
              var b3 = chunk.slice(p + oldheader.length);
              chunk = Buffer.concat([b1, b2, b3]);
            }
          }

          lastByte1 = chunk[chunk.length - 1];
          lastByte2 = chunk[chunk.length - 2];

          for (var i = self.audienceResponses.length; i--;) {
            var res = self.audienceResponses[i];

            // First time we push data... lets start at a boundary
            if (self.newAudienceResponses.indexOf(res) >= 0) {
              var p = buff.indexOf('--' + self.boundary);
              if (p >= 0) {
                res.write(chunk.slice(p));
                self.newAudienceResponses.splice(self.newAudienceResponses.indexOf(res), 1); // remove from new
              }
            } else {
              res.write(chunk);
            }
          }
        });
        mjpegResponse.on('end', function () {
          console.log("...end");
          for (var i = self.audienceResponses.length; i--;) {
            var res = self.audienceResponses[i];
            res.end();
          }
          self.emit("streamstop", "[MjpegProxy] 0 Users, Stopping stream " + mjpegUrl);

        });
        mjpegResponse.on('close', function () {
          console.log("...close");
        });
      });

      self.mjpegRequest.on('error', function (e) {
        console.error('problem with request: ', e);
        self.emit("error", { msg: e, url: mjpegUrl });
      });
      self.mjpegRequest.end();
    };

    self._newClient = function (req, res) {
      res.writeHead(200, {
        'Expires': 'Mon, 01 Jul 1980 00:00:00 GMT',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Content-Type': 'multipart/x-mixed-replace;boundary=' + self.boundary
      });

      self.audienceResponses.push(res);
      self.newAudienceResponses.push(res);

      res.socket.on('close', function () {
        // console.log('exiting client!');
        self.audienceResponses.splice(self.audienceResponses.indexOf(res), 1);
        if (self.newAudienceResponses.indexOf(res) >= 0) {
          self.newAudienceResponses.splice(self.newAudienceResponses.indexOf(res), 1); // remove from new
        }

        if (self.audienceResponses.length == 0) {
          self.mjpegRequest = null;
          try {
            self.globalMjpegResponse.destroy();
          } catch (e) {
            console.log(e);
          }
        }
      });
    };
  }
}



util.inherits(MjpegProxy, events.EventEmitter);


// module.exports =  MjpegProxy;
