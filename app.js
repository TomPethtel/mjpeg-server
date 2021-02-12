import { MjpegProxy } from './mjpeg-proxy.js';
import express from 'express';
import digest from 'node-digest-auth-client'

var app = express();

console.log("Starting to listen!");
app.listen(8080);

// Create Proxy 
var proxy1 = new MjpegProxy("http://ipaddr:8080/axis-cgi/mjpg/video.cgi?camera=1&resolution=1024x768", "user", "password")

// Bind proxy to the webserver
app.get('/ptz.jpg', proxy1.outerRequest);