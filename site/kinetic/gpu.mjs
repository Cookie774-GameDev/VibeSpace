// Batch the original glyph sprites, coordinates and opacity in one instanced draw.
export function createGlyphBatch(canvas){
 const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
 if(!gl)return null;
 const program=gl.createProgram();
 for(const [type,source] of [[gl.VERTEX_SHADER,`#version 300 es
 precision highp float;
 layout(location=0) in vec4 glyph;
 out vec2 uv;out float opacity;
 const vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 void main(){vec2 corner=corners[gl_VertexID];vec2 p=glyph.xy+corner*vec2(16,18);gl_Position=vec4(p.x/404.-1.,1.-p.y/500.,0,1);vec2 tile=vec2(mod(glyph.w,8.),floor(glyph.w/8.));uv=(tile+corner)/vec2(8,5);opacity=glyph.z;}`],
 [gl.FRAGMENT_SHADER,`#version 300 es
 precision highp float;uniform sampler2D atlas;in vec2 uv;in float opacity;out vec4 color;
 void main(){color=texture(atlas,uv);color.a*=opacity;}`]]){
  const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));gl.attachShader(program,shader);gl.deleteShader(shader);
 }
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);
 const buffer=gl.createBuffer(),points=new Float32Array(4096*4);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,points.byteLength,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,16,0);gl.vertexAttribDivisor(0,1);
 const atlas=new OffscreenCanvas(128,90),ctx=atlas.getContext('2d'),slots=new Map();let dirty=true,count=0,alpha=1;
 const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
 gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
 const context={setTransform(){},clearRect(){count=0},get globalAlpha(){return alpha},set globalAlpha(value){alpha=value},drawImage(sprite,x,y){
  let slot=slots.get(sprite);if(slot===undefined){slot=slots.size;slots.set(sprite,slot);ctx.drawImage(sprite,(slot%8)*16,Math.floor(slot/8)*18);dirty=true}
  const i=count++*4;points[i]=x;points[i+1]=y;points[i+2]=alpha;points[i+3]=slot;
 }};
 const surface={get width(){return canvas.width},get height(){return canvas.height},dataset:canvas.dataset,getContext(){return context}};
 return {surface,flush(){
  gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  if(dirty){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,atlas);dirty=false}
  gl.bufferSubData(gl.ARRAY_BUFFER,0,points.subarray(0,count*4));gl.drawArraysInstanced(gl.TRIANGLES,0,6,count);
 }};
}
