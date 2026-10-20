/* Liga as telas reconstruídas ao banco no Supabase.
 *
 * Cada página declara no <body>:
 *   data-tela="lista" | "form"
 *   data-tabela="pessoas"          tabela principal
 *   data-prefixo="pessoa"          prefixo dos campos do formulário (pessoa[nome])
 *   data-form="pessoas_new.html"   formulário aberto a partir da listagem
 *   data-lista="pessoas.html"      listagem para onde o formulário volta
 *   data-filtro-fixo='{"kit":true}' filtro sempre aplicado (opcional)
 *
 * Os nomes dos campos capturados do ERP são os nomes das colunas do banco,
 * então a ligação é quase toda genérica; o que não é fica em VISOES/ALIASES.
 */
(function () {
  'use strict';

  var META = window.ERP_META;
  var CFG = window.SUPABASE_CONFIG;
  // mesma conexão (e sessão de login) criada por guarda.js
  var sb = window.ERP_SB || window.supabase.createClient(CFG.url, CFG.anonKey);
  var corpo = document.body.dataset;
  var EMPRESA_ID = 1;

  // ---------- utilitários ----------
  function colunas(tabela) { return (META.tabelas[tabela] || {}); }
  function fkDe(tabela, coluna) { return ((META.fks[tabela] || {})[coluna]) || null; }
  function rotulo(reg) {
    if (!reg) return '';
    return reg.descricao || reg.nome || reg.sigla || reg.cep || reg.numero || String(reg.id);
  }
  var ROTULOS = { ufs: 'sigla', ncm: 'numero', origens_produtos: 'descricao' };
  function colunaRotulo(tabela) {
    if (ROTULOS[tabela]) return ROTULOS[tabela];
    var c = colunas(tabela);
    return ['descricao', 'nome', 'sigla', 'cep', 'numero'].filter(function (k) { return c[k]; })[0] || 'id';
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }
  function numBR(v, casas) {
    if (v == null || v === '') return '';
    return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }
  function dataBR(v) {
    if (!v) return '';
    var d = String(v).slice(0, 10).split('-');
    return d.length === 3 ? d[2] + '/' + d[1] + '/' + d[0] : v;
  }
  function dataHoraBR(v) {
    if (!v) return '';
    var dt = new Date(v);
    return isNaN(dt) ? v : dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function paraISO(br) {
    var d = String(br || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length !== 8) return undefined;                       // incompleta
    var dia = +d.slice(0, 2), mes = +d.slice(2, 4), ano = +d.slice(4);
    var dt = new Date(ano, mes - 1, dia);
    if (dt.getFullYear() !== ano || dt.getMonth() !== mes - 1 || dt.getDate() !== dia || ano < 1900) return undefined; // inexistente
    return d.slice(4) + '-' + d.slice(2, 4) + '-' + d.slice(0, 2);
  }
  function paraNumero(txt) {
    if (txt == null || txt === '') return null;
    var s = String(txt).replace(/[^\d,.-]/g, '');
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    var n = Number(s);
    return isNaN(n) ? null : n;
  }
  // as colunas são "timestamp without time zone": grava a hora local, não a UTC
  function agoraLocal() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function simNao(v) { return v === true ? 'Sim' : v === false ? 'Não' : ''; }
  function parametro(nome) { return new URLSearchParams(location.search).get(nome); }

  function aviso(msg, tipo) {
    var alvo = document.getElementById('atualiza_conteudo') || document.body;
    var div = document.createElement('div');
    div.className = 'alert alert-' + (tipo || 'danger') + ' alert-dismissable aviso-prototipo';
    div.innerHTML = '<button type="button" class="close" data-dismiss="alert">&times;</button>' + esc(msg);
    var antigo = alvo.querySelector('.aviso-prototipo');
    if (antigo) antigo.remove();
    alvo.insertBefore(div, alvo.firstChild);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function erroAmigavel(e) {
    var m = (e && (e.message || e.details)) || String(e);
    if (/^Aba .* incompleta|^Data inválida/.test(m)) return m;
    if (/date\/time field value out of range|invalid input syntax for type date/.test(m)) return 'Data inválida. Use dia/mês/ano, ex.: 06/12/1985.';
    var nn = /null value in column "(\w+)"/.exec(m);
    if (nn) return 'Campo obrigatório não preenchido: ' + nn[1].replace(/_id$/, '').replace(/_/g, ' ') + '.';
    if (/duplicate key/.test(m)) return 'Já existe um registro com esses dados.';
    if (/Failed to fetch/.test(m)) return 'Sem conexão com o banco (Supabase). Verifique a internet.';
    return 'Não foi possível salvar: ' + m;
  }

  // ---------- visões das listagens: colunas calculadas ----------
  var DESCR = {
    tipo_pessoa: { F: 'Física', J: 'Jurídica', E: 'Estrangeira' },
    sexo: { M: 'Masculino', F: 'Feminino' },
    estado_civil: { S: 'Solteiro(a)', C: 'Casado(a)', V: 'Viúvo(a)', D: 'Divorciado(a)', U: 'União estável', O: 'Outros' },
    finalidade: { C: 'Consumidor', R: 'Revendedor' }
  };
  var TIPO_SERVICO = { 1: 'BAT', 2: 'Garantia Estendida (Via Global) - Assurant', 3: 'Garantia Estendida - Generali' };

  var VISOES = {
    pessoas: {
      select: '*, filial:filiais!pessoas_filial_cadastro_id_fk(descricao), contatos:pessoas_contatos(meio_contato_id,informacao),' +
        ' enderecos:pessoas_enderecos(logradouro,numero,endereco_principal,bairro:bairros(descricao),cep:ceps(cep,cidade:cidades(descricao,uf:ufs(sigla))))',
      ordem: 'nome',
      calc: {
        descricao_tipo_pessoa: function (r) { return DESCR.tipo_pessoa[r.tipo_pessoa]; },
        descricao_filial_cadastro: function (r) { return r.filial && r.filial.descricao; },
        ativo: function (r) { return simNao(r.ativo); },
        descricao_sexo: function (r) { return DESCR.sexo[r.sexo]; },
        descricao_estado_civil: function (r) { return DESCR.estado_civil[r.estado_civil]; },
        descricao_finalidade: function (r) { return DESCR.finalidade[r.finalidade]; },
        renda: function (r) { return r.renda == null ? '' : 'R$ ' + numBR(r.renda, 2); },
        data_nascimento_fundacao: function (r) { return dataBR(r.data_nascimento_fundacao); },
        data_atualizacao_cadastro: function (r) { return dataHoraBR(r.data_atualizacao_cadastro); },
        created_at: function (r) { return dataHoraBR(r.created_at); },
        descricao_cliente: function (r) { return r.cliente ? 'Cliente' : ''; },
        descricao_fornecedor: function (r) { return r.fornecedor ? 'Fornecedor' : ''; },
        descricao_cidade: function (r) {
          var e = principal(r.enderecos); var c = e && e.cep && e.cep.cidade;
          return c ? c.descricao + ' - ' + (c.uf ? c.uf.sigla : '') : '';
        },
        endereco_completo: function (r) {
          var e = principal(r.enderecos); if (!e) return '';
          var c = e.cep && e.cep.cidade;
          return [e.logradouro, e.numero, e.bairro && e.bairro.descricao, c && (c.descricao + ' - ' + (c.uf ? c.uf.sigla : '')), e.cep && e.cep.cep]
            .filter(Boolean).join(', ');
        }
      },
      contato: true
    },
    produtos: {
      select: '*, unidade:unidades_medidas!produtos_unidade_medida_id_fk(sigla,descricao),' +
        ' subgrupo:subgrupos_produtos!produtos_subgrupo_produto_id_fk(descricao,grupo:grupos_produtos(descricao,departamento:departamentos_produtos(descricao))),' +
        ' marca:marcas_produtos!produtos_marca_produto_id_fk(descricao), cor:cores_produtos!produtos_cor_produto_id_fk(descricao),' +
        ' fornecedor:pessoas!produtos_fornecedor_padrao_id_fk(nome), origem:origens_produtos!produtos_origem_produto_id_fk(numero,descricao),' +
        ' ncm_reg:ncm!produtos_ncm_id_fk(numero),' +
        ' itens:itens_kits_produtos!fk_rails_4f0c0a0a76(quantidade,produto:produtos!fk_rails_5976b0c2bb(codigo,descricao))',
      ordem: 'codigo',
      calc: {
        quantidade_disponivel_estoque: function () { return '0'; },
        descricao_unidade_medida: function (r) { return r.unidade && r.unidade.descricao; },
        ativo: function (r) { return simNao(r.ativo); },
        descricao_departamento: function (r) { return r.subgrupo && r.subgrupo.grupo && r.subgrupo.grupo.departamento && r.subgrupo.grupo.departamento.descricao; },
        descricao_grupo: function (r) { return r.subgrupo && r.subgrupo.grupo && r.subgrupo.grupo.descricao; },
        descricao_subgrupo: function (r) { return r.subgrupo && r.subgrupo.descricao; },
        descricao_marca: function (r) { return r.marca && r.marca.descricao; },
        descricao_cor: function (r) { return r.cor && r.cor.descricao; },
        nome_fornecedor: function (r) { return r.fornecedor && r.fornecedor.nome; },
        possui_grade: function (r) { return simNao(r.grade); },
        kit: function (r) { return simNao(r.kit); },
        _produtos_kits: function (r) { return (r.itens || []).map(function (i) { return i.produto && i.produto.descricao; }).join(', '); },
        produto_preco_padrao: function () { return ''; },
        link_custos: function () { return ''; },
        icone_anexo: function () { return ''; },
        descricao_origem_produto: function (r) { return r.origem && (r.origem.numero + ' - ' + r.origem.descricao); },
        numero_ncm: function (r) { return r.ncm_reg && r.ncm_reg.numero; },
        created_at: function (r) { return dataHoraBR(r.created_at); },
        informacoes_complementares: function (r) { return r.informacoes_adicionais; },
        _possui_montagem: function (r) { return simNao(r.possui_montagem); },
        fora_linha: function (r) { return simNao(r.fora_linha); },
        // listagem de kits
        codigo_descricao: function (r) { return r.codigo + ' - ' + r.descricao; },
        _produtos: function (r) {
          return (r.itens || []).map(function (i) { return numBR(i.quantidade, 0) + ' x ' + (i.produto ? i.produto.descricao : ''); }).join('<br>');
        },
        venda_integral_kit: function (r) { return simNao(r.venda_integral_kit); }
      },
      html: { _produtos: true }
    },
    servicos: {
      select: '*, subgrupo:subgrupos_produtos!servicos_subgrupo_produto_id_fk(descricao), marca:marcas_produtos!servicos_marca_produto_id_fk(descricao)',
      ordem: 'descricao',
      calc: {
        tipo: function (r) { return TIPO_SERVICO[r.tipo] || r.tipo; },
        descricao_subgrupo: function (r) { return r.subgrupo && r.subgrupo.descricao; },
        descricao_marca: function (r) { return r.marca && r.marca.descricao; },
        ativo: function (r) { return simNao(r.ativo); },
        vende_automaticamente: function (r) { return simNao(r.vende_automaticamente); },
        permite_recuperacao: function (r) { return simNao(r.permite_recuperacao); }
      }
    }
  };

  // telas sem visão escrita à mão: monta a partir das colunas da tabela e das chaves.
  // "descricao_marca" vira marca_id -> marcas_produtos(descricao), e assim por diante.
  function formatar(v, def) {
    if (v == null) return '';
    if (typeof v === 'boolean') return simNao(v);
    if (!def) return v;
    if (def.tipo === 'date') return dataBR(v);
    if (def.tipo === 'ts') return dataHoraBR(v);
    if (def.tipo === 'num') return numBR(v, 2);
    return v;
  }
  function fkPorNome(tabela, base, coluna) {
    var fks = META.fks[tabela] || {};
    if (fks[base + '_id']) return base + '_id';
    // "descricao_filial_cadastro" -> filial_cadastro_id; "nome_fornecedor" -> fornecedor_padrao_id;
    // "nome_cliente_fornecedor" -> pessoa_cliente_fornecedor_id (e não endereco_cliente_fornecedor_id: endereço não tem nome)
    var notas = Object.keys(fks).map(function (c) {
      var n = c === base + '_id' ? 4 : /_id$/.test(c) && c.slice(-(base.length + 4)) === '_' + base + '_id' ? 3
        : c.indexOf(base) === 0 ? 2 : c.indexOf('_' + base + '_') >= 0 ? 1 : 0;
      if (n && coluna && colunas(fks[c].tabela)[coluna]) n += 10;
      return { c: c, n: n };
    }).filter(function (x) { return x.n; }).sort(function (a, b) { return b.n - a.n; });
    return notas[0] ? notas[0].c : null;
  }
  function visaoGenerica(tabela, ids) {
    var cols = colunas(tabela), embutir = {}, calc = {};
    function embutido(raiz, t, colFk) {
      var fk = fkDe(t, colFk), ap = 'r_' + colFk;
      raiz[ap] = raiz[ap] || { tabela: fk.tabela, coluna: colFk, sub: {} };
      return raiz[ap];
    }
    // embute pela coluna (r_x:x_id(*)): funciona também quando a tabela aponta para ela mesma
    function texto(no) {
      return Object.keys(no).map(function (ap) {
        var s = texto(no[ap].sub);
        return ap + ':' + no[ap].coluna + '(*' + (s ? ',' + s : '') + ')';
      }).join(',');
    }
    function chavesDe(t) { return Object.keys(META.fks[t] || {}).filter(function (k) { return k !== 'empresa_id'; }); }
    ids.forEach(function (c) {
      if (cols[c]) { calc[c] = function (r) { return formatar(r[c], cols[c]); }; return; }
      // "_ativo": versão formatada da coluna "ativo"
      var limpa = c.replace(/^_+/, '');
      if (cols[limpa]) { calc[c] = function (r) { return formatar(r[limpa], cols[limpa]); }; return; }
      var m = /^(descricao|nome|sigla|numero|codigo)_(.+)$/.exec(c);
      var colFk = m ? fkPorNome(tabela, m[2], m[1]) : (fkDe(tabela, c + '_id') ? c + '_id' : null);
      if (colFk) {
        var no = embutido(embutir, tabela, colFk), alvo = colunas(no.tabela);
        var mostrar = m && alvo[m[1]] ? m[1] : colunaRotulo(no.tabela), ap = 'r_' + colFk;
        calc[c] = function (r) { return r[ap] ? formatar(r[ap][mostrar], alvo[mostrar]) : ''; };
        return;
      }
      // coluna de uma tabela ligada (auditorias -> usuarios.login)
      var direto = chavesDe(tabela).filter(function (k) { return fkDe(tabela, k).tabela !== tabela && colunas(fkDe(tabela, k).tabela)[c]; })[0];
      if (direto) {
        embutido(embutir, tabela, direto);
        var ad = 'r_' + direto, td = fkDe(tabela, direto).tabela;
        calc[c] = function (r) { return r[ad] ? formatar(r[ad][c], colunas(td)[c]) : ''; };
        return;
      }
      // ... ou a dois passos (bairros -> cidades -> ufs.sigla)
      var achado = null;
      chavesDe(tabela).some(function (k1) {
        var t2 = fkDe(tabela, k1).tabela;
        if (t2 === tabela) return false;
        return chavesDe(t2).some(function (k2) {
          if (colunas(fkDe(t2, k2).tabela)[c]) { achado = [k1, t2, k2]; return true; }
          return false;
        });
      });
      if (!achado) { calc[c] = function () { return ''; }; return; }
      embutido(embutido(embutir, tabela, achado[0]).sub, achado[1], achado[2]);
      var a1 = 'r_' + achado[0], a2 = 'r_' + achado[2];
      calc[c] = function (r) { return r[a1] && r[a1][a2] ? formatar(r[a1][a2][c]) : ''; };
    });
    var s = texto(embutir);
    return { select: '*' + (s ? ',' + s : ''), ordem: colunaRotulo(tabela), calc: calc };
  }

  function principal(lista) {
    if (!lista || !lista.length) return null;
    return lista.filter(function (e) { return e.endereco_principal; })[0] || lista[0];
  }

  // ---------- LISTAGEM ----------
  function iniciarLista() {
    var tabela = corpo.tabela;
    var tab = document.querySelector('table[id^="lista_padrao"]');
    if (!tab || !META.tabelas[tabela]) return;
    var tbody = tab.querySelector('tbody');
    var cols = Array.prototype.map.call(tab.querySelectorAll('thead th[data-coluna_id]'), function (th) {
      return { id: th.dataset.coluna_id, classe: th.className.replace(/\btitulo_/g, 'campo_') };
    });
    var visao = VISOES[tabela] || visaoGenerica(tabela, cols.map(function (c) { return c.id; }));
    // paginação capturada mostra os números do ERP real: some até termos a nossa
    Array.prototype.forEach.call(document.querySelectorAll('.pagination'), function (p) { p.style.display = 'none'; });
    var form = document.querySelector('form.formulario-filtros') || (tab.closest('#atualiza_conteudo') || document).querySelector('form');

    function valor(r, c) {
      if (visao.calc[c]) return visao.calc[c](r);
      var m = /^meio_contato_(\d+)$/.exec(c);
      if (m && visao.contato) {
        var ct = (r.contatos || []).filter(function (x) { return String(x.meio_contato_id) === m[1]; })[0];
        return ct ? ct.informacao : '';
      }
      var v = r[c];
      if (typeof v === 'boolean') return simNao(v);
      return v;
    }

    function desenhar(regs) {
      if (!regs.length) {
        tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="text-center">Nenhum registro encontrado.</td></tr>';
        return;
      }
      tbody.innerHTML = regs.map(function (r) {
        var link = corpo.form ? corpo.form + '?id=' + r.id : '';
        return '<tr>' + cols.map(function (c, i) {
          var v = valor(r, c.id);
          var txt = (visao.html && visao.html[c.id]) ? (v || '') : esc(v);
          if (i === 0 && link) txt = '<a href="' + link + '">' + (txt === '' ? '(sem descrição)' : txt) + '</a>';
          return '<td class="' + esc(c.classe) + '" data-title="' + esc(c.id) + '">' + txt + '</td>';
        }).join('') + '</tr>';
      }).join('');
    }

    function filtros() {
      var f = {};
      if (!form) return f;
      Array.prototype.forEach.call(form.querySelectorAll('[name^="filtros["]'), function (el) {
        var k = el.name.slice(8, -1);
        if (el.type === 'checkbox') { if (el.closest('.bootstrap-switch')) f[k] = el.checked ? 'true' : ''; return; }
        if (el.value !== '' && el.value != null) f[k] = el.value;
      });
      return f;
    }

    function carregar() {
      tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="text-center">Carregando...</td></tr>';
      var q = sb.from(tabela).select(visao.select).order(visao.ordem).limit(200);
      var fixo = corpo.filtroFixo ? JSON.parse(corpo.filtroFixo) : {};
      Object.keys(fixo).forEach(function (k) { q = q.eq(k, fixo[k]); });
      var f = filtros(), c = colunas(tabela);
      Object.keys(f).forEach(function (k) {
        var v = f[k];
        if (k.indexOf('.') >= 0 || k.charAt(0) === '_') return;            // filtros por outras tabelas: ainda não
        if (/_ilike$/.test(k)) { var base = k.replace(/_ilike$/, ''); if (c[base]) q = q.ilike(base, '%' + v + '%'); return; }
        if (k === 'primeiro_nome') return;
        if (k === 'exibe_produto_kit') { if (v !== 'true') q = q.eq('kit', false); return; }
        if (!c[k]) return;
        if (c[k].tipo === 'text' && k !== 'tipo_pessoa' && k !== 'finalidade') q = q.ilike(k, '%' + v + '%');
        else q = q.eq(k, v === 'true' ? true : v === 'false' ? false : v);
      });
      q.then(function (res) {
        if (res.error) { aviso(erroAmigavel(res.error)); desenhar([]); return; }
        desenhar(res.data || []);
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) { e.preventDefault(); carregar(); });
      Array.prototype.forEach.call(form.querySelectorAll('button, input[type="submit"]'), function (b) {
        var t = (b.textContent || b.value || '').trim();
        if (/Filtrar/.test(t)) b.addEventListener('click', function (e) { e.preventDefault(); carregar(); });
        if (/Limpar/.test(t)) b.addEventListener('click', function (e) {
          e.preventDefault();
          Array.prototype.forEach.call(form.querySelectorAll('input[type="text"], select'), function (el) { el.value = ''; });
          carregar();
        });
      });
    }
    carregar();
  }

  // ---------- FORMULÁRIO ----------
  var FILHOS = {
    pessoas: {
      enderecos_attributes: { tabela: 'pessoas_enderecos', pai: 'pessoa_id' },
      contatos_attributes: { tabela: 'pessoas_contatos', pai: 'pessoa_id' },
      referencias_attributes: { tabela: 'pessoas_referencias', pai: 'pessoa_id' },
      dependentes_attributes: { tabela: 'dependentes', pai: 'pessoa_id' }
    },
    produtos: {
      fornecedores_produtos_attributes: { tabela: 'fornecedores_produtos', pai: 'produto_id' },
      conversoes_medidas_produtos_attributes: { tabela: 'conversoes_medidas_produtos', pai: 'produto_id' },
      itens_kits_attributes: { tabela: 'itens_kits_produtos', pai: 'produto_kit_id' }
    },
    servicos: {}
  };
  var ALIASES = { pessoas: { apelido: 'nome_fantasia' } };

  // aba filha sem entrada em FILHOS: procura a tabela que aponta para a principal
  // ("agencias_attributes" -> agencias.banco_id -> bancos)
  var filhosCache = {};
  function filhoDe(tabela, assoc) {
    if (FILHOS[tabela] && FILHOS[tabela][assoc]) return FILHOS[tabela][assoc];
    var chave = tabela + '|' + assoc;
    if (chave in filhosCache) return filhosCache[chave];
    var nome = assoc.replace(/_attributes$/, '');
    var candidatas = Object.keys(META.fks).map(function (t) {
      var pai = Object.keys(META.fks[t]).filter(function (c) { return META.fks[t][c].tabela === tabela && c !== 'empresa_id'; })[0];
      if (!pai || t === tabela) return null;
      var nota = t === nome ? 3 : t.indexOf(nome) >= 0 ? 2 : nome.indexOf(t) >= 0 ? 1 : 0;
      return nota ? { tabela: t, pai: pai, nota: nota } : null;
    }).filter(Boolean).sort(function (a, b) { return b.nota - a.nota; });
    return filhosCache[chave] = candidatas[0] ? { tabela: candidatas[0].tabela, pai: candidatas[0].pai } : null;
  }

  // alguns campos do ERP vêm como x[itens_kits_attributes[0]][col]; padroniza para x[itens_kits_attributes][0][col]
  function nomePadrao(nome) { return String(nome || '').replace(/\[([a-z_]+_attributes)\[(\d+)\]\]/, '[$1][$2]'); }

  function campos(prefixo) {
    var re = new RegExp('^' + prefixo + '\\[([a-z_0-9]+)\\](?:\\[(\\d+)\\]\\[([a-z_0-9]+)\\])?$');
    var lista = [];
    Array.prototype.forEach.call(document.querySelectorAll('[name^="' + prefixo + '["]'), function (el) {
      var m = re.exec(nomePadrao(el.name));
      if (m) lista.push({ el: el, coluna: m[2] ? m[3] : m[1], assoc: m[2] ? m[1] : null, indice: m[2] || null });
    });
    return lista;
  }

  function tabelaDoCampo(tabela, cp) {
    if (!cp.assoc) return tabela;
    var f = filhoDe(tabela, cp.assoc);
    return f ? f.tabela : null;
  }

  function lerCampo(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.classList.contains('opcao-componente-radio')) return el.classList.contains('btn-primary') ? el.value : undefined;
    return el.value;
  }

  function converter(valor, def) {
    if (valor === undefined) return undefined;
    if (!def) return valor;
    if (def.tipo === 'bool') return valor === true || valor === 'true';
    if (valor === '' || valor == null) return null;
    if (def.tipo === 'int') return paraNumero(valor) == null ? null : Math.round(paraNumero(valor));
    if (def.tipo === 'num') return paraNumero(valor);
    if (def.tipo === 'date') {
      var iso = paraISO(valor);
      if (iso === undefined) throw new Error('Data inválida: "' + valor + '". Use dia/mês/ano, ex.: 06/12/1985.');
      return iso;
    }
    return valor;
  }

  function escrever(el, valor, def) {
    if (el.type === 'checkbox') {
      el.checked = !!valor;
      var sw = el.closest('.bootstrap-switch');
      if (sw) { sw.classList.toggle('bootstrap-switch-on', !!valor); sw.classList.toggle('bootstrap-switch-off', !valor); }
      return;
    }
    if (el.classList.contains('opcao-componente-radio')) {
      var ativo = String(el.value) === String(valor);
      el.classList.toggle('btn-primary', ativo); el.classList.toggle('btn-default', !ativo);
      return;
    }
    if (el.type === 'file') return;
    if (valor == null) { el.value = ''; return; }
    if (def && def.tipo === 'date') el.value = dataBR(valor);
    else if (def && def.tipo === 'num') el.value = numBR(valor, 2);
    else el.value = valor;
  }

  // listas de seleção que apontam para outra tabela: opções vêm do nosso banco
  function prepararSelects(tabela, lista) {
    var pendentes = [];
    lista.forEach(function (cp) {
      if (cp.el.tagName !== 'SELECT' || !/_id$/.test(cp.coluna)) return;
      var t = tabelaDoCampo(tabela, cp); var fk = t && fkDe(t, cp.coluna);
      if (!fk) return;
      var col = colunaRotulo(fk.tabela);
      pendentes.push(sb.from(fk.tabela).select('id,' + col).order(col).limit(500).then(function (res) {
        if (res.error) return;
        var atual = cp.el.value;
        cp.el.innerHTML = '<option value="">Selecione</option>' + res.data.map(function (r) {
          return '<option value="' + r.id + '">' + esc(r[col]) + '</option>';
        }).join('');
        cp.el.value = atual;
      }));
    });
    return Promise.all(pendentes);
  }

  // campos com busca (digita e escolhe): usa <datalist> com resultados do banco
  function prepararBuscas(tabela) {
    Array.prototype.forEach.call(document.querySelectorAll('input.tt-input[atributo]'), function (vis, n) {
      var atributo = vis.getAttribute('atributo');
      var grupo = vis.closest('.form-group') || vis.parentNode;
      var oculto = grupo.querySelector('input[type="hidden"][name$="[' + atributo + ']"]') ||
        document.querySelector('input[type="hidden"][name$="[' + atributo + ']"]');
      var nomeOculto = oculto ? nomePadrao(oculto.name) : '';
      var m = /\[([a-z_]+_attributes)\]\[\d+\]/.exec(nomeOculto);
      var t = m ? (filhoDe(tabela, m[1]) || {}).tabela : tabela;
      var fk = t && fkDe(t, atributo);
      if (!fk) return;
      vis.disabled = false;
      var sugerida = String(vis.dataset.atributo_descricao || '').split('.').pop();
      var col = colunas(fk.tabela)[sugerida] ? sugerida : colunaRotulo(fk.tabela);
      vis.dataset.colunaRef = col;
      var dl = document.createElement('datalist');
      dl.id = 'busca_' + n;
      document.body.appendChild(dl);
      vis.setAttribute('list', dl.id);
      vis.setAttribute('autocomplete', 'off');
      vis.dataset.tabelaRef = fk.tabela;
      var mapa = {}, espera;
      // filtros que o ERP declara no campo (ex.: só clientes ativos: {"cliente":true})
      var fixos = {};
      try { fixos = JSON.parse(vis.dataset.filtros || '{}'); } catch (e) { fixos = {}; }
      var colsRef = colunas(fk.tabela);
      Object.keys(fixos).forEach(function (k) { if (!colsRef[k] || typeof fixos[k] === 'object') delete fixos[k]; });
      function buscar() {
        var q = sb.from(fk.tabela).select('id,' + col).ilike(col, '%' + vis.value + '%');
        Object.keys(fixos).forEach(function (k) { q = q.eq(k, fixos[k]); });
        q.order(col).limit(30).then(function (res) {
          if (res.error) return;
          mapa = {};
          dl.innerHTML = res.data.map(function (r) { mapa[r[col]] = r.id; return '<option value="' + esc(r[col]) + '">'; }).join('');
        });
      }
      vis.addEventListener('focus', buscar);
      // texto digitado por inteiro (sem escolher na lista): confirma pelo valor exato.
      // O Salvar também chama isto, para não gravar antes de a busca voltar.
      vis._confirmar = function () {
        if (!oculto || !vis.value) return Promise.resolve();
        if (oculto.value) return vis._preenchendo || Promise.resolve();
        return vis._preenchendo = sb.from(fk.tabela).select('id').ilike(col, vis.value).limit(1).then(function (res) {
          if (!res.error && res.data.length) return res.data[0].id;
          // CEP que ainda não está no banco: busca no ViaCEP e cadastra (como o "Buscar CEP" do ERP)
          if (fk.tabela === 'ceps') {
            var dica = vis.placeholder;
            vis.placeholder = 'Buscando CEP...';
            vis.style.cursor = 'progress';
            return cadastrarCep(vis.value).then(function (idCep) {
              vis.placeholder = dica || ''; vis.style.cursor = '';
              return idCep;
            });
          }
          return null;
        }).then(function (idEncontrado) {
          if (!idEncontrado) return null;
          oculto.value = idEncontrado;
          return aoEscolher(atributo, idEncontrado, oculto);
        });
      };
      vis.addEventListener('change', function () { vis._confirmar(); });

      // CEP: máscara 99999-999 e busca automática ao completar 8 dígitos (como o ERP)
      if (fk.tabela === 'ceps') {
        vis.setAttribute('maxlength', '9');
        vis.setAttribute('inputmode', 'numeric');
        vis.addEventListener('input', function () {
          var d = vis.value.replace(/\D/g, '').slice(0, 8);
          var formatado = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
          if (vis.value !== formatado) vis.value = formatado;
          if (d.length === 8) { if (oculto) oculto.value = ''; vis._confirmar(); }
        });
        vis.addEventListener('blur', function () {
          var d = vis.value.replace(/\D/g, '');
          if (d.length && d.length !== 8) aviso('CEP incompleto: digite os 8 números (ex.: 59650-000).');
        });
        var botoes = [];
        var addon = vis.closest('.input-group');
        if (addon) botoes = botoes.concat(Array.prototype.slice.call(addon.querySelectorAll('.input-group-addon')));
        var grupoCep = vis.closest('.form-group');
        if (grupoCep) Array.prototype.forEach.call(grupoCep.querySelectorAll('a'), function (a) {
          if (/Buscar CEP/i.test(a.textContent)) botoes.push(a);
        });
        botoes.forEach(function (b) {
          b.style.cursor = 'pointer';
          b.addEventListener('click', function (e) {
            e.preventDefault();
            var d = vis.value.replace(/\D/g, '');
            if (d.length !== 8) { aviso('CEP incompleto: digite os 8 números (ex.: 59650-000).'); vis.focus(); return; }
            if (oculto) oculto.value = '';
            vis._confirmar();
          });
        });
      }
      vis.addEventListener('input', function () {
        clearTimeout(espera); espera = setTimeout(buscar, 250);
        if (oculto) oculto.value = mapa[vis.value] != null ? mapa[vis.value] : '';
        if (oculto && oculto.value) oculto.dispatchEvent(new Event('change'));
      });
      if (oculto) {
        oculto.addEventListener('change', function () { vis._preenchendo = aoEscolher(atributo, oculto.value, oculto); });
        oculto.dataset.visivel = vis.id;
      }
    });
  }

  // ---------- CEP novo: consulta o ViaCEP e cria cidade, bairro e CEP ----------
  // Só o número do CEP é enviado ao ViaCEP (serviço público); nada da pessoa.
  function buscarOuCriar(tabela, filtros, novo) {
    var q = sb.from(tabela).select('id');
    Object.keys(filtros).forEach(function (k) { q = q.eq(k, filtros[k]); });
    return q.limit(1).then(function (res) {
      if (res.error) throw res.error;
      if (res.data.length) return res.data[0].id;
      var agora = agoraLocal();
      var dados = Object.assign({ empresa_id: EMPRESA_ID, created_at: agora, updated_at: agora }, filtros, novo || {});
      return sb.from(tabela).insert(dados).select('id').single().then(function (r) {
        if (r.error) throw r.error;
        return r.data.id;
      });
    });
  }

  var cepsEmAndamento = {};
  function cadastrarCep(texto) {
    var digitos = String(texto).replace(/\D/g, '');
    if (digitos.length !== 8) return Promise.resolve(null);
    // a mesma busca pode ser pedida duas vezes (sair do campo + Salvar): reaproveita
    if (!cepsEmAndamento[digitos]) {
      cepsEmAndamento[digitos] = consultarViaCep(digitos).then(function (id) {
        if (!id) delete cepsEmAndamento[digitos];
        return id;
      });
    }
    return cepsEmAndamento[digitos];
  }

  function consultarViaCep(digitos) {
    var cepFormatado = digitos.slice(0, 5) + '-' + digitos.slice(5);
    return fetch('https://viacep.com.br/ws/' + digitos + '/json/').then(function (r) { return r.json(); }).then(function (v) {
      if (!v || v.erro) { aviso('CEP ' + cepFormatado + ' não encontrado.'); return null; }
      return sb.from('ufs').select('id').eq('sigla', v.uf).single().then(function (uf) {
        if (uf.error) throw uf.error;
        var ibge = parseInt(v.ibge, 10) || null;
        return buscarOuCriar('cidades', ibge ? { codigo_ibge: ibge } : { descricao: v.localidade.toUpperCase(), uf_id: uf.data.id },
          { descricao: v.localidade.toUpperCase(), uf_id: uf.data.id });
      }).then(function (cidadeId) {
        var bairro = (v.bairro || 'CENTRO').toUpperCase();
        return buscarOuCriar('bairros', { descricao: bairro, cidade_id: cidadeId }).then(function (bairroId) {
          return buscarOuCriar('ceps', { cep: cepFormatado }, {
            cidade_id: cidadeId, bairro_id: bairroId, logradouro: (v.logradouro || '').toUpperCase() || null
          });
        });
      });
    }).catch(function (e) { aviso('Não foi possível consultar o CEP: ' + (e.message || e)); return null; });
  }

  // ao escolher o CEP, preenche bairro, cidade e UF da mesma linha de endereço
  function preencherPeloCep(id, oculto) {
    var base = oculto.name.replace(/\[cep_id\]$/, '');
    function campo(nome) { return document.querySelector('[name="' + base + '[' + nome + ']"]'); }
    return sb.from('ceps').select('logradouro, bairro:bairros(id,descricao), cidade:cidades(id,descricao,uf:ufs(sigla))').eq('id', id).single()
      .then(function (res) {
        if (res.error || !res.data) return;
        var c = res.data;
        if (c.bairro && campo('bairro_id')) {
          campo('bairro_id').value = c.bairro.id;
          var vb = document.getElementById(campo('bairro_id').dataset.visivel || '');
          if (vb) vb.value = c.bairro.descricao;
        }
        if (c.cidade) {
          if (campo('cidade_id')) campo('cidade_id').value = c.cidade.id;
          if (campo('cidade')) campo('cidade').value = c.cidade.descricao;
          if (campo('uf') && c.cidade.uf) campo('uf').value = c.cidade.uf.sigla;
        }
        if (c.logradouro && campo('logradouro') && !campo('logradouro').value) campo('logradouro').value = c.logradouro;
      });
  }

  // ao escolher o subgrupo, mostra grupo e departamento (como o ERP faz)
  function aoEscolher(atributo, id, oculto) {
    if (atributo === 'cep_id' && id && oculto) return preencherPeloCep(id, oculto);
    if (atributo !== 'subgrupo_produto_id' || !id) return Promise.resolve();
    return sb.from('subgrupos_produtos').select('grupo:grupos_produtos(descricao,departamento:departamentos_produtos(descricao))').eq('id', id).single()
      .then(function (res) {
        if (res.error || !res.data.grupo) return;
        var g = res.data.grupo;
        Array.prototype.forEach.call(document.querySelectorAll('[name$="[grupo_produto_descricao]"]'), function (el) { el.value = g.descricao; });
        Array.prototype.forEach.call(document.querySelectorAll('[name$="[departamento_produto_descricao]"]'), function (el) { el.value = g.departamento ? g.departamento.descricao : ''; });
      });
  }

  function preencherBuscas(registro, filhos) {
    Array.prototype.forEach.call(document.querySelectorAll('input[type="hidden"][data-visivel]'), function (oc) {
      if (!oc.value) return;
      var vis = document.getElementById(oc.dataset.visivel);
      if (!vis || !vis.dataset.tabelaRef) return;
      var col = vis.dataset.colunaRef || colunaRotulo(vis.dataset.tabelaRef);
      sb.from(vis.dataset.tabelaRef).select(col).eq('id', oc.value).single().then(function (res) {
        if (!res.error && res.data) vis.value = res.data[col];
        aoEscolher(vis.getAttribute('atributo'), oc.value, oc);
      });
    });
  }

  function iniciarForm() {
    var tabela = corpo.tabela, prefixo = corpo.prefixo;
    var id = parametro('id');
    var lista = campos(prefixo);
    var cols = colunas(tabela);
    var aliases = ALIASES[tabela] || {};

    prepararBuscas(tabela);
    var prontos = prepararSelects(tabela, lista);
    prontos.then(function () {
      lista.forEach(function (cp) { var v = lerCampo(cp.el); cp.el.dataset.inicial = v === undefined ? '' : String(v); });
    });

    if (id) {
      var titulo = document.querySelector('#barra_superior .titulo');
      if (titulo) titulo.lastChild.textContent = titulo.lastChild.textContent.replace('Adicionar', 'Editar');
      var assocs = Object.keys(FILHOS[tabela] || {});
      lista.forEach(function (cp) { if (cp.assoc && assocs.indexOf(cp.assoc) < 0) assocs.push(cp.assoc); });
      var embutir = assocs.map(function (a) {
        var f = filhoDe(tabela, a);
        return f ? a + ':' + f.tabela + '!' + fkDe(f.tabela, f.pai).fk + '(*)' : null;
      }).filter(Boolean);
      Promise.all([prontos, sb.from(tabela).select(['*'].concat(embutir).join(',')).eq('id', id).single()]).then(function (r) {
        var res = r[1];
        if (res.error) { aviso(erroAmigavel(res.error)); return; }
        var reg = res.data;
        lista.forEach(function (cp) {
          if (cp.assoc) {
            var filho = (reg[cp.assoc] || [])[Number(cp.indice)];
            var tf = tabelaDoCampo(tabela, cp);
            if (filho && tf) escrever(cp.el, filho[cp.coluna], colunas(tf)[cp.coluna]);
            return;
          }
          var col = aliases[cp.coluna] || cp.coluna;
          if (col in reg) escrever(cp.el, reg[col], cols[col]);
        });
        Array.prototype.forEach.call(document.querySelectorAll('[name$="[gera_codigo_automatico]"]'), function (el) { el.checked = false; });
        var data = document.querySelector('.data-atualizacao-cadastro');
        if (data) data.textContent = 'Data da última atualização: ' + dataHoraBR(reg.data_atualizacao_cadastro || reg.updated_at);
        preencherBuscas(reg);
        sincronizarBlocos();
      });
    }

    function salvar(continuar) {
      var pendentes = Array.prototype.map.call(document.querySelectorAll('input.tt-input'), function (v) {
        return v._confirmar ? v._confirmar() : null;
      });
      return Promise.all(pendentes).then(function () { return gravar(continuar); })
        .catch(function (e) { aviso(erroAmigavel(e)); });
    }

    function gravar(continuar) {
      var dados = {}, filhos = {};
      lista.forEach(function (cp) {
        var v = lerCampo(cp.el);
        if (v === undefined) return;
        if (cp.assoc) {
          var tf = tabelaDoCampo(tabela, cp); if (!tf) return;
          var def = colunas(tf)[cp.coluna];
          if (!def && cp.coluna !== '_destroy') return;
          var chave = cp.assoc + '#' + cp.indice;
          filhos[chave] = filhos[chave] || { assoc: cp.assoc, tabela: tf, dados: {}, alterado: false, rotulos: {} };
          if (cp.coluna !== '_destroy' && cp.coluna !== 'id' && cp.el.type !== 'hidden' && String(v) !== (cp.el.dataset.inicial || '')) filhos[chave].alterado = true;
          var lbl = (cp.el.closest('.form-group') || {}).querySelector ? cp.el.closest('.form-group').querySelector('label') : null;
          if (lbl) filhos[chave].rotulos[cp.coluna] = lbl.textContent.replace('*', '').trim();
          if (cp.el.type === 'checkbox' && !cp.el.closest('.bootstrap-switch') && cp.coluna !== '_destroy' && def.tipo !== 'bool') return;
          filhos[chave].dados[cp.coluna] = converter(v, def);
          return;
        }
        var col = aliases[cp.coluna] || cp.coluna;
        if (!cols[col] || col === 'id') return;
        if (cp.el.type === 'hidden' && cp.el.closest('.bootstrap-switch') == null && cols[col].tipo === 'bool' && dados[col] !== undefined) return;
        dados[col] = converter(v, cols[col]);
      });

      var agora = agoraLocal();
      if (cols.empresa_id) dados.empresa_id = EMPRESA_ID;
      if (cols.data_atualizacao_cadastro) dados.data_atualizacao_cadastro = agora;
      if (cols.updated_at) dados.updated_at = agora;
      if (!id && cols.created_at) dados.created_at = agora;
      if (tabela === 'pessoas' && !dados.tipo_pessoa) dados.tipo_pessoa = 'F';
      // o ERP preenche pela loja do usuário logado; no protótipo, a loja padrão
      if (cols.filial_cadastro_id && !id && !dados.filial_cadastro_id) dados.filial_cadastro_id = 1;
      if (cols.filial_id && cols.filial_id.obrigatorio && !id && !dados.filial_id) dados.filial_id = 1;

      var gerar = document.querySelector('[name$="[gera_codigo_automatico]"]');
      var precisaCodigo = cols.codigo && (!dados.codigo) && (!gerar || gerar.checked || cols.codigo.obrigatorio);
      var passoCodigo = precisaCodigo
        ? sb.from(tabela).select('codigo').order('id', { ascending: false }).limit(50).then(function (res) {
          var max = 0;
          (res.data || []).forEach(function (r) { var n = parseInt(r.codigo, 10); if (n > max) max = n; });
          dados.codigo = String(max + 1);
        })
        : Promise.resolve();

      return passoCodigo.then(function () {
        var q = id ? sb.from(tabela).update(dados).eq('id', id).select('id').single() : sb.from(tabela).insert(dados).select('id').single();
        return q;
      }).then(function (res) {
        if (res.error) throw res.error;
        var novoId = res.data.id;
        // a partir daqui a tela edita este registro: um novo Salvar não duplica
        if (!id) { id = String(novoId); history.replaceState(null, '', '?id=' + novoId); }
        return salvarFilhos(tabela, novoId, filhos).then(function () { return novoId; });
      }).then(function (novoId) {
        if (continuar) {
          aviso('Registro salvo com sucesso.', 'success');
        } else {
          location.href = corpo.lista + '?salvo=1';
        }
      }).catch(function (e) { aviso(erroAmigavel(e)); });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.crud-btn-salvar, .crud-btn-salvar-continuar'), function (b) {
      b.type = 'button';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        salvar(b.classList.contains('crud-btn-salvar-continuar'));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('a, button, input[type="button"]'), function (b) {
      if (/^\s*Voltar\s*$/.test(b.textContent || b.value || '')) {
        b.addEventListener('click', function (e) { e.preventDefault(); location.href = corpo.lista; });
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
      f.addEventListener('submit', function (e) { e.preventDefault(); });
    });
  }

  // grava as linhas filhas (endereços, contatos...) que tiverem conteúdo
  function salvarFilhos(tabela, paiId, filhos) {
    var passos = Object.keys(filhos).map(function (k) {
      var f = filhos[k], def = filhoDe(tabela, f.assoc), d = f.dados;
      var temConteudo = Object.keys(d).some(function (c) {
        return c !== 'id' && c !== '_destroy' && d[c] !== null && d[c] !== '' && d[c] !== false && colunas(f.tabela)[c] && colunas(f.tabela)[c].tipo !== 'bool';
      });
      var idFilho = d.id; delete d.id;
      var apagar = d._destroy === true || d._destroy === 'true'; delete d._destroy;
      if (apagar && idFilho) return sb.from(f.tabela).delete().eq('id', idFilho);
      // linha que o usuário não tocou (só valores padrão da tela): não grava
      if (!temConteudo || (!idFilho && !f.alterado)) return Promise.resolve();
      var c0 = colunas(f.tabela);
      var faltando = Object.keys(c0).filter(function (col) {
        return c0[col].obrigatorio && col !== def.pai && col !== 'empresa_id' && col !== 'created_at' && col !== 'updated_at' && (d[col] === null || d[col] === undefined || d[col] === '');
      });
      if (faltando.length) {
        var nomes = faltando.map(function (col) { return f.rotulos[col] || f.rotulos[col.replace(/_id$/, '')] || col.replace(/_id$/, '').replace(/_/g, ' '); });
        var aba = { enderecos_attributes: 'Endereços', contatos_attributes: 'Contatos', referencias_attributes: 'Referências', dependentes_attributes: 'Dependentes' }[f.assoc] || f.assoc.replace(/_attributes$/, '').replace(/_/g, ' ');
        return Promise.reject(new Error('Aba ' + aba + ' incompleta. Preencha: ' + nomes.join(', ') + '.'));
      }
      d[def.pai] = paiId;
      var c = colunas(f.tabela), agora = agoraLocal();
      if (c.empresa_id) d.empresa_id = EMPRESA_ID;
      if (c.updated_at) d.updated_at = agora;
      if (!idFilho && c.created_at) d.created_at = agora;
      var q = idFilho ? sb.from(f.tabela).update(d).eq('id', idFilho) : sb.from(f.tabela).insert(d);
      return q.then(function (res) { if (res.error) throw res.error; });
    });
    return Promise.all(passos);
  }

  // ---------- máscaras (as mesmas que o ERP declara no atributo "mascara") ----------
  function aplicarMascara(valor, mascara) {
    var dig = String(valor).replace(/\D/g, ''), out = '', i = 0;
    for (var k = 0; k < mascara.length && i < dig.length; k++) {
      if (mascara[k] === '9') out += dig[i++];
      else out += mascara[k];
    }
    return out;
  }
  function mascaraDe(el) {
    if (/\[cpf_cnpj\]$/.test(el.name || '')) {
      var tipo = document.querySelector('.opcao-componente-radio.btn-primary[name$="[tipo_pessoa]"]');
      var t = tipo ? tipo.value : 'F';
      if (t === 'J') return '99.999.999/9999-99';
      if (t === 'E') return null;                               // estrangeiro: documento livre
      return '999.999.999-99';
    }
    return el.getAttribute('mascara');
  }
  function prepararMascaras() {
    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'INPUT' || !el.hasAttribute('mascara')) return;
      var m = mascaraDe(el);
      if (!m) return;
      var novo = aplicarMascara(el.value, m);
      if (novo !== el.value) el.value = novo;
    }, true);
    // Física / Jurídica / Estrangeira: troca rótulo e máscara do documento
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.opcao-componente-radio[name$="[tipo_pessoa]"]');
      if (!b) return;
      setTimeout(function () {
        var doc = document.querySelector('input[name$="[cpf_cnpj]"][mascara]');
        if (!doc) return;
        var m = mascaraDe(doc);
        doc.setAttribute('maxlength', m ? m.length : 30);
        if (m) doc.value = aplicarMascara(doc.value, m);
        var lbl = document.querySelector('label[for="' + doc.id + '"]') || (doc.closest('.form-group') || {}).querySelector && doc.closest('.form-group').querySelector('label');
        if (lbl) lbl.textContent = (b.value === 'J' ? 'CNPJ' : b.value === 'E' ? 'Documento' : 'CPF') + '*';
      }, 0);
    });
  }

  // interruptor ligado mostra o bloco que depende dele (ex.: Kit -> #conteudo_kit), como o ERP faz
  function sincronizarBlocos() {
    Array.prototype.forEach.call(document.querySelectorAll('.bootstrap-switch input[type="checkbox"][id]'), function (cb) {
      var bloco = document.getElementById('conteudo_' + cb.id);
      if (bloco) bloco.classList.toggle('hide', !cb.checked);
    });
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.bootstrap-switch')) setTimeout(sincronizarBlocos, 0);
  });
  window.ERP_sincronizarBlocos = sincronizarBlocos;

  // usado pelas telas com lógica própria (ex.: venda.js)
  window.ERP = {
    sb: sb, META: META, EMPRESA_ID: EMPRESA_ID, colunas: colunas, fkDe: fkDe, colunaRotulo: colunaRotulo,
    agora: agoraLocal, esc: esc, numBR: numBR, dataBR: dataBR, dataHoraBR: dataHoraBR, paraISO: paraISO, paraNumero: paraNumero,
    parametro: parametro, aviso: aviso, erroAmigavel: erroAmigavel, prepararBuscas: prepararBuscas,
    preencherBuscas: preencherBuscas, prepararMascaras: prepararMascaras
  };

  document.addEventListener('DOMContentLoaded', function () {
    (window.ERP_SESSAO || Promise.resolve(true)).then(function (sessao) {
      if (!sessao) return;                                   // sem login: guarda.js já redirecionou
      if (parametro('salvo')) aviso('Registro salvo com sucesso.', 'success');
      if (corpo.tela === 'lista') iniciarLista();
      if (corpo.tela === 'form') { prepararMascaras(); iniciarForm(); }
      if (corpo.tela === 'venda' && window.ERP_VENDA) window.ERP_VENDA.iniciar();
    });
  });
})();
