import { parse } from 'acorn';

// Bounded static evaluation of the site's data initialization only.
// No eval, Function, browser APIs, network, or execution of page handlers.
export function extractDomains(html) {
  if (html.length > 300_000) throw new Error('域名发布页超过大小限制');
  const date = html.match(/(?:更新时间[：:]?\s*|iKuuuVPN最新域名\s*)(\d{4}-\d{2}-\d{2})/)?.[1];
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const links = [...markup.matchAll(/href=["']https:\/\/(ikuuu\.[a-z]{2,24})\/?["']/gi)].map(match => match[1].toLowerCase());
  if (date && links.length) {
    return {updatedAt:date, domains:[...new Set(links)].slice(0,5).map((host,index)=>({host,url:`https://${host}/`,role:index === 0 ? '主要域名' : `备用域名 ${index}`}))};
  }
  const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).find(s => s.includes('async function _0x440325'));
  if (!source) throw new Error('域名发布页结构变化，保留上次验证的域名');
  const ast = parse(source, {ecmaVersion:'latest'});
  const tableFunction = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === '_0xfccb');
  const table = tableFunction.body.body[0].declarations[0].init.elements.map(n => n.value);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const decode = value => {
    const mapped = [...value].map(c => standard[alphabet.indexOf(c)]).join('');
    return new TextDecoder().decode(Uint8Array.from(atob(mapped), c => c.charCodeAt(0)));
  };
  const global = Object.create(null);
  global.parseInt = parseInt;
  global._0xfccb = () => table;
  global._0x355a = index => decode(table[index - 0x147]);
  let budget = 200_000;
  function evaluate(node, env) {
    if (--budget < 0) throw new Error('Static parser budget exceeded');
    switch (node.type) {
      case 'Literal': return node.value;
      case 'Identifier':
        if (!(node.name in env)) throw new Error(`Unknown data symbol: ${node.name}`);
        return env[node.name];
      case 'ArrayExpression': return node.elements.map(n => evaluate(n,env));
      case 'ObjectExpression': return Object.fromEntries(node.properties.map(p => [p.key.name ?? p.key.value,evaluate(p.value,env)]));
      case 'UnaryExpression': {
        const value=evaluate(node.argument,env);
        if (node.operator === '-') return -value;
        if (node.operator === '+') return +value;
        if (node.operator === '!') return !value;
        throw new Error('Unsupported unary expression');
      }
      case 'BinaryExpression': {
        const left=evaluate(node.left,env), right=evaluate(node.right,env);
        if(node.operator === '+') return left+right;
        if(node.operator === '-') return left-right;
        if(node.operator === '*') return left*right;
        if(node.operator === '/') return left/right;
        throw new Error('Unsupported binary expression');
      }
      case 'MemberExpression': {
        const key=node.computed ? evaluate(node.property,env) : node.property.name;
        if(['constructor','prototype','__proto__'].includes(key)) throw new Error('Forbidden member');
        return evaluate(node.object,env)[key];
      }
      case 'CallExpression': {
        if(node.callee.type !== 'Identifier') throw new Error('Unsupported data call');
        return evaluate(node.callee,env)(...node.arguments.map(n => evaluate(n,env)));
      }
      case 'AssignmentExpression': {
        if(node.operator !== '=' || node.left.type !== 'MemberExpression') throw new Error('Unsupported data assignment');
        const key=node.left.computed ? evaluate(node.left.property,env) : node.left.property.name;
        if(['constructor','prototype','__proto__'].includes(key)) throw new Error('Forbidden assignment');
        return evaluate(node.left.object,env)[key]=evaluate(node.right,env);
      }
      case 'SequenceExpression': return node.expressions.map(n => evaluate(n,env)).at(-1);
      default: throw new Error(`Unsupported data node: ${node.type}`);
    }
  }
  function declare(node,env) {
    for(const d of node.declarations) {
      if(d.id.type !== 'Identifier') throw new Error('Unsupported declaration');
      env[d.id.name]=evaluate(d.init,env);
    }
  }
  function wrapper(node,parent) {
    if(node.async) throw new Error('Async page code is not allowed');
    return (...args) => {
      const env=Object.create(parent);
      node.params.forEach((p,i)=>env[p.name]=args[i]);
      for(const s of node.body.body) {
        if(s.type === 'VariableDeclaration') declare(s,env);
        else if(s.type === 'ReturnStatement') return evaluate(s.argument,env);
        else throw new Error('Unsupported wrapper statement');
      }
    };
  }
  // Register numeric index wrappers, never arbitrary page functions.
  for(const name of ['_0xa4c552','_0x232eeb']) {
    const fn=ast.body.find(n=>n.type==='FunctionDeclaration' && n.id.name===name);
    global[name]=wrapper(fn,global);
  }
  const rotation=ast.body[0].expression;
  const rotateEnv=Object.create(global);
  rotation.callee.params.forEach((p,i)=>rotateEnv[p.name]=evaluate(rotation.arguments[i],global));
  for(const s of rotation.callee.body.body) {
    if(s.type==='FunctionDeclaration') rotateEnv[s.id.name]=wrapper(s,rotateEnv);
  }
  for(const s of rotation.callee.body.body) {
    if(s.type==='VariableDeclaration') declare(s,rotateEnv);
  }
  const whileNode=rotation.callee.body.body.find(n=>n.type==='WhileStatement');
  const tryNode=whileNode.body.body.find(n=>n.type==='TryStatement');
  const checksum=tryNode.block.body.find(n=>n.type==='VariableDeclaration').declarations[0].init;
  const expected=evaluate(rotation.arguments[1],global);
  let matched=false;
  for(let i=0;i<table.length;i++) {
    if(evaluate(checksum,rotateEnv)===expected) {matched=true;break;}
    table.push(table.shift());
  }
  if(!matched) throw new Error('String table checksum did not match');
  for(const node of ast.body.slice(1)) {
    if(node.type==='FunctionDeclaration' && node.async) break;
    if(node.type==='VariableDeclaration') declare(node,global);
    else if(node.type==='ExpressionStatement') evaluate(node.expression,global);
  }
  const domains=global._0x450b43.map(d=>({host:d.name,url:d.url,role:d.description}));
  for(const d of domains) {
    if(!/^ikuuu\.[a-z]{2,24}$/.test(d.host) || d.url!==`https://${d.host}/`) throw new Error('Invalid candidate');
  }
  const updatedAt=global._0x9cddd0;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) throw new Error('Invalid update date');
  return {updatedAt,domains};
}
