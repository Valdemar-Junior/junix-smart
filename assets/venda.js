/* Pedido de Venda (tela /vendas do ERP) ligado ao Supabase.
 *
 * Grava em documentos (cabeçalho), itens_documentos (produtos) e
 * pagamentos_documentos (formas de pagamento e parcelas).
 * Usa as funções comuns expostas por erp-dados.js em window.ERP.
 */
(function () {
  'use strict';

  var E, sb;
  var TABELA_PRECO_PADRAO = 1;
  var FILIAL_PADRAO = 1;
  var LISTA = 'documentos_tipo_movimento_S.html';

  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function $$(sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); }
  function num(v) { var n = E.paraNumero(v); return n == null ? 0 : n; }
  function moeda(v) { return E.numBR(v || 0, 2); }
  function hojeBR(somaDias) {
    var d = new Date(); d.setDate(d.getDate() + (somaDias || 0));
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
  }
  function somaMeses(br, meses) {
    var p = String(br).split('/'); var d = new Date(+p[2], +p[1] - 1 + meses, +p[0]);
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
  }
  // quando o código chama "observar", reage à troca de valor de um campo oculto (as buscas preenchem sem evento)
  function observar(el, cb) {
    var ultimo = el.value;
    setInterval(function () { if (el.value !== ultimo) { ultimo = el.value; cb(el.value); } }, 300);
  }

  // ---------- células editáveis (clica e aparece o campo, como no ERP) ----------
  function partesCelula(td) {
    var divs = $$(':scope > div', td);
    return { exibe: divs[0], campo: divs[1] };
  }
  function abrirCelula(td) {
    var p = partesCelula(td);
    if (!p.campo || !p.campo.classList.contains('hide')) return;
    p.exibe.style.display = 'none';
    p.campo.classList.remove('hide');
    var el = p.campo.querySelector('input:not([type="hidden"]), select');
    if (el) { el.focus(); if (el.select && el.tagName === 'INPUT') el.select(); }
  }
  function fecharCelula(td) {
    var p = partesCelula(td);
    if (!p.campo || p.campo.classList.contains('hide')) return;
    var el = p.campo.querySelector('input:not([type="hidden"]), select');
    if (td.classList.contains('coluna-descricao-produto')) {
      var linha = td.closest('tr');
      var desc = linha.dataset.descricaoProduto;
      p.exibe.innerHTML = desc ? E.esc(desc) : '<span class="text-muted"><i class="glyphicon glyphicon-search" style="margin-right:5px"></i> Pesquisar</span>';
    } else if (el) {
      p.exibe.textContent = el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : el.value;
    }
    p.exibe.style.display = '';
    p.campo.classList.add('hide');
  }
  function prepararCelulas() {
    document.addEventListener('click', function (e) {
      var td = e.target.closest && e.target.closest('td.coluna-editavel');
      if (td && !td.classList.contains('coluna-codigo-unico')) abrirCelula(td);
    });
    document.addEventListener('focusout', function (e) {
      var td = e.target.closest && e.target.closest('td.coluna-editavel');
      if (!td) return;
      setTimeout(function () { if (!td.contains(document.activeElement)) fecharCelula(td); }, 150);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.closest && e.target.closest('td.coluna-editavel')) {
        e.preventDefault(); e.target.blur();
      }
    });
  }

  // ---------- listas de seleção ----------
  function trocarBootstrapSelect() {
    // o ERP usa um componente com pesquisa; aqui fica a lista nativa
    $$('.bootstrap-select').forEach(function (w) {
      var sel = w.querySelector('select');
      if (!sel) return;
      w.parentNode.insertBefore(sel, w);
      w.remove();
      sel.style.display = '';
      sel.classList.remove('bs-select-hidden', 'selectpicker');
    });
  }
  function opcoes(sel, regs, rotulo, extras) {
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecione</option>' + regs.map(function (r) {
      var attrs = extras ? extras(r) : '';
      return '<option value="' + r.id + '"' + attrs + '>' + E.esc(rotulo(r)) + '</option>';
    }).join('');
  }
  var formasPagamento = {};
  function carregarListas() {
    return Promise.all([
      sb.from('operacoes_documentos').select('id,descricao,grupo:grupos_operacoes_documentos!inner(tipo_movimento)')
        .eq('grupo.tipo_movimento', 'S').order('id'),
      sb.from('modelos_nf').select('id,descricao').eq('ativo', true).order('id'),
      sb.from('formas_pagamentos').select('id,descricao,tipo').order('ordem_exibicao'),
      sb.from('tipos_enderecos').select('id,descricao').order('descricao')
    ]).then(function (r) {
      r.forEach(function (x) { if (x.error) throw x.error; });
      var op = $('#operacao_documento_id');
      opcoes(op, r[0].data, function (o) { return o.descricao; });
      if (r[0].data[0]) op.value = r[0].data[0].id;
      var mod = $('#modelo_nf_id');
      opcoes(mod, r[1].data, function (o) { return o.descricao; });
      if (r[1].data[0]) mod.value = r[1].data[0].id;
      r[2].data.forEach(function (f) { formasPagamento[f.id] = f; });
      $$('select.forma-pagamento-id').forEach(function (s) {
        opcoes(s, r[2].data, function (f) { return f.descricao; }, function (f) { return ' data-tipo="' + f.tipo + '"'; });
      });
      // locais de estocagem e demais listas capturadas do ERP: sem uso no protótipo
      var local = $('#_local_estocagem_padrao_usuario');
      if (local) local.innerHTML = '<option value="">Selecione Local de Estocagem</option>';
    });
  }

  // ---------- produtos ----------
  var corpoItens, modeloLinha;
  function linhas() { return $$('tr.copia-linha', corpoItens); }
  function campoLinha(tr, atributo) {
    // a busca visível do produto também tem atributo="produto_id": o id fica no campo oculto
    if (atributo === 'produto_id') return tr.querySelector('input.input-produto-id');
    return tr.querySelector('[atributo="' + atributo + '"]');
  }

  function renumerar() {
    linhas().forEach(function (tr, i) {
      var seq = tr.querySelector('.numero-sequencia-produto');
      if (seq) seq.textContent = i + 1;
    });
  }

  function novaLinha() {
    var n = Date.now() % 100000;           // índice único para nomes e ids
    var tr = modeloLinha.cloneNode(true);
    $$('[name]', tr).forEach(function (el) { el.name = el.name.replace(/itens_documentos_attributes\[\d+\]/, 'itens_documentos_attributes[' + n + ']'); });
    $$('[id]', tr).forEach(function (el) { el.id = el.id.replace(/_0$/, '_' + n); });
    $$('label[for]', tr).forEach(function (el) { el.htmlFor = el.htmlFor.replace(/_0$/, '_' + n); });
    corpoItens.appendChild(tr);
    prepararLinha(tr);
    limparLinha(tr);
    renumerar();
    return tr;
  }

  function limparLinha(tr) {
    delete tr.dataset.descricaoProduto;
    ['produto_id', 'tabela_preco_id', 'id'].forEach(function (a) { var c = campoLinha(tr, a); if (c) c.value = ''; });
    var q = campoLinha(tr, 'quantidade'); if (q) q.value = '0';
    ['valor_unitario', 'valor_descontos', 'percentual_descontos'].forEach(function (a) { var c = campoLinha(tr, a); if (c) c.value = '0,00'; });
    var busca = tr.querySelector('input.input-produto'); if (busca) busca.value = '';
    $$('td.coluna-editavel', tr).forEach(function (td) {
      var p = partesCelula(td);
      if (!p.exibe) return;
      var el = p.campo && p.campo.querySelector('input:not([type="hidden"])');
      if (td.classList.contains('coluna-descricao-produto')) fecharCelula(td);
      else p.exibe.textContent = el ? el.value : '';
    });
    calcularLinha(tr);
  }

  function prepararLinha(tr) {
    var busca = tr.querySelector('input.input-produto');
    if (!busca) return;
    busca.setAttribute('autocomplete', 'off');
    busca.placeholder = 'Código ou descrição';
    E.sugestoes(busca, buscarProdutos, function (item) { escolherProduto(tr, item.produto); }, true);
    busca.addEventListener('input', function () { campoLinha(tr, 'produto_id').value = ''; });
    busca.addEventListener('change', function () {
      if (campoLinha(tr, 'produto_id').value || !busca.value.trim()) return;
      // digitou o código (ou o texto exato da lista) sem escolher: procura exato
      var codigo = busca.value.trim().split(' - ')[0];
      sb.from('produtos').select('id,codigo,descricao').eq('codigo', codigo).limit(1)
        .then(function (r) { if (!r.error && r.data.length) escolherProduto(tr, r.data[0]); });
    });
    ['quantidade', 'valor_unitario', 'valor_descontos'].forEach(function (a) {
      var c = campoLinha(tr, a);
      if (c) c.addEventListener('input', function () { calcularLinha(tr); });
    });
    var perc = campoLinha(tr, 'percentual_descontos');
    if (perc) perc.addEventListener('input', function () {
      var bruto = num(campoLinha(tr, 'quantidade').value) * num(campoLinha(tr, 'valor_unitario').value);
      campoLinha(tr, 'valor_descontos').value = moeda(bruto * num(perc.value) / 100);
      calcularLinha(tr, true);
    });
    var remover = tr.querySelector('.check-remove-produto');
    if (remover) remover.addEventListener('change', function () {
      if (linhas().length > 1) tr.remove(); else limparLinha(tr);
      renumerar(); calcularTotais();
    });
  }

  function rotuloProduto(p) { return p.codigo + ' - ' + p.descricao; }
  function buscarProdutos(texto) {
    var t = String(texto || '').replace(/^\d+\s-\s/, '').trim().replace(/[,()]/g, ' ');
    var q = sb.from('produtos').select('id,codigo,descricao').eq('ativo', true).order('descricao').limit(30);
    if (t) q = q.or('descricao.ilike.%' + t + '%,codigo.ilike.' + t.replace(/\s/g, '') + '%');
    return q.then(function (r) {
      if (r.error) return [];
      return r.data.map(function (p) { return { id: p.id, rotulo: rotuloProduto(p), produto: p }; });
    });
  }

  function escolherProduto(tr, p, dadosItem) {
    campoLinha(tr, 'produto_id').value = p.id;
    tr.dataset.descricaoProduto = rotuloProduto(p);
    var busca = tr.querySelector('input.input-produto'); if (busca) busca.value = rotuloProduto(p);
    return Promise.all([
      sb.from('produtos').select('unidade_medida_id, possui_montagem, unidade:unidades_medidas!produtos_unidade_medida_id_fk(id,sigla,descricao)').eq('id', p.id).single(),
      sb.from('itens_tabelas_precos').select('preco').eq('produto_id', p.id).eq('tabela_preco_id', TABELA_PRECO_PADRAO).limit(1)
    ]).then(function (r) {
      var prod = r[0].data || {}, preco = (r[1].data && r[1].data[0]) ? Number(r[1].data[0].preco) : 0;
      var un = campoLinha(tr, 'unidade_medida_id');
      if (un && prod.unidade) un.innerHTML = '<option value="' + prod.unidade.id + '">' + E.esc(prod.unidade.sigla || prod.unidade.descricao) + '</option>';
      var tp = campoLinha(tr, 'tabela_preco_id'); if (tp) tp.value = TABELA_PRECO_PADRAO;
      var mont = campoLinha(tr, 'possui_montagem'); if (mont) mont.disabled = !prod.possui_montagem;
      var q = campoLinha(tr, 'quantidade');
      if (dadosItem) {
        q.value = E.numBR(dadosItem.quantidade, 0);
        campoLinha(tr, 'valor_unitario').value = moeda(dadosItem.valor_unitario);
        campoLinha(tr, 'valor_descontos').value = moeda(dadosItem.valor_descontos);
        if (campoLinha(tr, 'possui_entrega')) campoLinha(tr, 'possui_entrega').checked = !!dadosItem.possui_entrega;
        if (mont) mont.checked = !!dadosItem.possui_montagem;
      } else {
        if (num(q.value) === 0) q.value = '1';
        campoLinha(tr, 'valor_unitario').value = moeda(preco);
        if (!preco) E.aviso('Produto sem preço na tabela padrão: informe o valor unitário.', 'warning');
      }
      $$('td.coluna-editavel', tr).forEach(function (td) {
        var pc = partesCelula(td);
        if (!pc.campo || !pc.campo.classList.contains('hide')) return;
        var el = pc.campo.querySelector('input:not([type="hidden"]), select');
        if (td.classList.contains('coluna-descricao-produto')) pc.exibe.textContent = rotuloProduto(p);
        else if (el) pc.exibe.textContent = el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : el.value;
      });
      calcularLinha(tr);
      // última linha preenchida: já deixa uma nova pronta, como o ERP
      if (!dadosItem && tr === linhas()[linhas().length - 1]) novaLinha();
    });
  }

  function calcularLinha(tr, percentualDigitado) {
    var q = num(campoLinha(tr, 'quantidade').value), u = num(campoLinha(tr, 'valor_unitario').value);
    var d = num(campoLinha(tr, 'valor_descontos').value), bruto = q * u;
    var total = bruto - d;
    var cel = tr.querySelector('.coluna-valor-total-liquido'); if (cel) cel.textContent = moeda(total);
    var qn = campoLinha(tr, 'quantidade_nota'); if (qn) qn.value = String(q);
    var perc = campoLinha(tr, 'percentual_descontos');
    if (perc && !percentualDigitado) perc.value = moeda(bruto ? d / bruto * 100 : 0);
    // atualiza o texto das células fechadas
    ['quantidade_nota', 'percentual_descontos', 'valor_descontos'].forEach(function (a) {
      var c = campoLinha(tr, a); var td = c && c.closest('td.coluna-editavel');
      if (td && partesCelula(td).campo.classList.contains('hide')) partesCelula(td).exibe.textContent = c.value;
    });
    calcularTotais();
  }

  // ---------- totais ----------
  // alguns campos têm uma cópia oculta com o mesmo nome (ex.: previsão de entrega): vale a visível
  function campoDoc(nome) {
    var sel = '[name="documento_saida[' + nome + ']"]';
    return document.querySelector(sel + ':not([type="hidden"])') || document.querySelector(sel);
  }
  var descontoEmPercentual = false;
  var totais = {};
  function calcularTotais() {
    var itens = 0, descontos = 0;
    linhas().forEach(function (tr) {
      if (!campoLinha(tr, 'produto_id').value) return;
      itens += num(campoLinha(tr, 'quantidade').value) * num(campoLinha(tr, 'valor_unitario').value);
      descontos += num(campoLinha(tr, 'valor_descontos').value);
    });
    var campoDesc = $('#campo_desconto_documento');
    var descDoc = num(campoDesc && campoDesc.value);
    if (descontoEmPercentual) descDoc = (itens - descontos) * descDoc / 100;
    var frete = num(campoDoc('valor_frete').value), desp = num(campoDoc('valor_despesas_acessorias').value), seg = num(campoDoc('valor_seguro').value);
    var total = itens - descontos - descDoc + frete + desp + seg;
    totais = { itens: itens, descontos: descontos, descontoDocumento: descDoc, frete: frete, despesas: desp, seguro: seg, total: total };
    campoDoc('valor_itens').value = moeda(itens);
    campoDoc('desconto_produtos').value = moeda(descontos);
    campoDoc('desconto_documento').value = descDoc.toFixed(2);
    campoDoc('valor_total_documento').value = moeda(total);
    sugerirPagamento();
  }
  function prepararTotais() {
    ['valor_frete', 'valor_despesas_acessorias', 'valor_seguro'].forEach(function (n) {
      campoDoc(n).addEventListener('input', calcularTotais);
    });
    var campoDesc = $('#campo_desconto_documento');
    if (campoDesc) campoDesc.addEventListener('input', calcularTotais);
    $$('.opcao-campo-percentual-monetario').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        descontoEmPercentual = a.classList.contains('opcao-percentual');
        var t = $('.titulo-opcao-percentual-monetario'); if (t) t.textContent = descontoEmPercentual ? '%' : 'R$';
        calcularTotais();
      });
    });
  }

  // ---------- pagamento ----------
  var containerPag, modeloPag, modeloParcela;
  function linhasPag() { return $$('.linha-painel-pagamentos', containerPag); }
  function campoPag(div, atributo) { return div.querySelector('[atributo="' + atributo + '"]'); }
  var pagamentoEditado = false;

  function sugerirPagamento() {
    var ls = linhasPag();
    if (!modeloParcela || !ls.length || pagamentoEditado) return;
    // enquanto o vendedor não mexe no valor, a primeira forma recebe o total
    campoPag(ls[0], 'valor').value = moeda(totais.total);
    gerarParcelas(ls[0]);
  }

  function prepararLinhaPag(div) {
    var sel = div.querySelector('select.forma-pagamento-id');
    var valor = campoPag(div, 'valor');
    var qtd = div.querySelector('[atributo="parcelas"]');
    var primeiro = div.querySelector('[atributo="data_primeiro_vencimento"]');
    if (primeiro) primeiro.value = hojeBR(30);
    sel.addEventListener('change', function () { mostrarParcelamento(div); gerarParcelas(div); });
    valor.addEventListener('input', function () { pagamentoEditado = true; gerarParcelas(div); });
    valor.addEventListener('change', function () { completarPagamentos(div); });
    if (qtd) qtd.addEventListener('input', function () { gerarParcelas(div); });
    if (primeiro) primeiro.addEventListener('change', function () { gerarParcelas(div); });
    mostrarParcelamento(div);
  }

  function aPrazo(div) {
    var f = formasPagamento[div.querySelector('select.forma-pagamento-id').value];
    return !!f && f.tipo === 'a_prazo';
  }
  function mostrarParcelamento(div) {
    var prazo = aPrazo(div);
    ['#parcela', '#data_primeiro_vencimento', '#tabela_pagamentos'].forEach(function (s) {
      var el = div.querySelector(s); if (el) el.classList.toggle('hidden', !prazo);
    });
    $$('.coluna-dados-cheque', div).forEach(function (el) { el.style.display = 'none'; });
  }

  function gerarParcelas(div, existentes) {
    var corpo = div.querySelector('.conteiner-linhas-tabela-pagamentos');
    if (!corpo) return;
    var total = num(campoPag(div, 'valor').value);
    var n = aPrazo(div) ? Math.max(1, parseInt(div.querySelector('[atributo="parcelas"]').value, 10) || 1) : 1;
    var primeiro = (div.querySelector('[atributo="data_primeiro_vencimento"]') || {}).value || hojeBR(30);
    primeiro = primeiro.slice(0, 10);
    var base = Math.floor(total / n * 100) / 100;
    corpo.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var tr = modeloParcela.cloneNode(true);
      var valor = existentes ? existentes[i].valor : (i === n - 1 ? total - base * (n - 1) : base);
      var venc = existentes ? E.dataBR(existentes[i].data_vencimento) : (aPrazo(div) ? somaMeses(primeiro, i) : hojeBR(0));
      tr.querySelector('.coluna-numero-parcela').textContent = i + 1;
      var cv = tr.querySelector('.coluna-data-vencimento'), cvalor = tr.querySelector('.coluna-valor');
      partesCelula(cv).exibe.textContent = venc; cv.querySelector('input').value = venc;
      partesCelula(cvalor).exibe.textContent = moeda(valor); cvalor.querySelector('input').value = moeda(valor);
      $$('.coluna-dados-cheque', tr).forEach(function (el) { el.style.display = 'none'; });
      corpo.appendChild(tr);
    }
  }

  // valor menor que o total: abre outra forma de pagamento com o restante
  function completarPagamentos(div) {
    var soma = linhasPag().reduce(function (s, d) { return s + num(campoPag(d, 'valor').value); }, 0);
    var falta = Math.round((totais.total - soma) * 100) / 100;
    var ultima = linhasPag()[linhasPag().length - 1];
    if (falta > 0 && div === ultima) {
      var nova = novaLinhaPag();
      campoPag(nova, 'valor').value = moeda(falta);
      gerarParcelas(nova);
    }
  }

  function novaLinhaPag() {
    var k = linhasPag().length;
    var div = modeloPag.cloneNode(true);
    $$('[name]', div).forEach(function (el) { el.name = el.name.replace(/\[dados_dos_pagamentos\]\[\d+\]/, '[dados_dos_pagamentos][' + k + ']'); });
    $$('[id]', div).forEach(function (el) { el.id = el.id.replace(/_0(_0)?$/, '_' + k + '$1'); });
    containerPag.appendChild(div);
    prepararLinhaPag(div);
    return div;
  }

  function lerPagamentos() {
    var lista = [];
    linhasPag().forEach(function (div, agrupador) {
      var fp = div.querySelector('select.forma-pagamento-id').value;
      var valor = num(campoPag(div, 'valor').value);
      if (!fp && !valor) return;
      if (!fp) throw new Error('Escolha a forma de pagamento do valor de R$ ' + moeda(valor) + '.');
      $$('.conteiner-linhas-tabela-pagamentos tr', div).forEach(function (tr, i) {
        var venc = tr.querySelector('.coluna-data-vencimento input').value;
        var iso = E.paraISO(venc);
        if (iso === undefined) throw new Error('Vencimento inválido na parcela ' + (i + 1) + ': ' + venc + '.');
        lista.push({ forma_pagamento_id: Number(fp), tipo: formasPagamento[fp] ? formasPagamento[fp].tipo : 'a_vista',
          parcela: i + 1, valor: num(tr.querySelector('.coluna-valor input').value), data_vencimento: iso, agrupador: agrupador + 1 });
      });
    });
    return lista;
  }

  // ---------- dados do cliente ----------
  function mostrarCliente(id) {
    var painel = $('#dados_do_cliente');
    var nome = document.querySelector('[name="[documento_saida][pessoa_cliente_fornecedor_attributes][nome]"]');
    var doc = document.querySelector('[name="[documento_saida][pessoa_cliente_fornecedor_attributes][cpf_cnpj]"]');
    var tipo = document.querySelector('[name="[documento_saida][pessoa_cliente_fornecedor_attributes][tipo_pessoa]"]');
    var end = $('#endereco_cliente_fornecedor_id');
    if (!id) return;
    sb.from('pessoas').select('nome,cpf_cnpj,tipo_pessoa, enderecos:pessoas_enderecos!pessoas_enderecos_pessoa_id_fk(id,logradouro,numero,endereco_principal,bairro:bairros(descricao)), contatos:pessoas_contatos(informacao,meio:meios_contatos(descricao))')
      .eq('id', id).single().then(function (r) {
        if (r.error || !r.data) return;
        var p = r.data;
        if (nome) { nome.value = p.nome || ''; nome.readOnly = true; }
        if (doc) { doc.value = p.cpf_cnpj || ''; doc.readOnly = true; }
        if (tipo && p.tipo_pessoa) tipo.value = p.tipo_pessoa;
        if (end) {
          end.disabled = false;
          end.innerHTML = (p.enderecos || []).map(function (e) {
            return '<option value="' + e.id + '"' + (e.endereco_principal ? ' selected' : '') + '>' +
              E.esc([e.logradouro, e.numero, e.bairro && e.bairro.descricao].filter(Boolean).join(', ')) + '</option>';
          }).join('') || '<option value="">Cliente sem endereço cadastrado</option>';
        }
        var email = campoDoc('email_envio_nfe');
        var c = (p.contatos || []).filter(function (x) { return /@/.test(x.informacao || ''); })[0];
        if (email && !email.value && c) email.value = c.informacao;
        if (painel && window.jQuery) window.jQuery(painel).collapse('show');
      });
  }

  // ---------- gravar ----------
  var docId = null;
  function validar() {
    var faltas = [];
    if (!$('#operacao_documento_id').value) faltas.push('Operação');
    if (!$('#vendedor_id').value) faltas.push('Vendedor');
    if (faltas.length) throw new Error('Preencha: ' + faltas.join(', ') + '.');
    var itens = linhas().filter(function (tr) { return campoLinha(tr, 'produto_id').value; });
    if (!itens.length) throw new Error('Inclua ao menos um produto.');
    itens.forEach(function (tr, i) {
      if (num(campoLinha(tr, 'quantidade').value) <= 0) throw new Error('Informe a quantidade do produto ' + (i + 1) + '.');
    });
    var pags = lerPagamentos();
    var soma = pags.reduce(function (s, p) { return s + p.valor; }, 0);
    if (Math.abs(soma - totais.total) > 0.009) {
      throw new Error('O pagamento (R$ ' + moeda(soma) + ') precisa fechar com o total da venda (R$ ' + moeda(totais.total) + ').');
    }
    return { itens: itens, pagamentos: pags };
  }

  function proximoLancamento() {
    return sb.from('documentos').select('numero_lancamento').not('numero_lancamento', 'is', null)
      .order('numero_lancamento', { ascending: false }).limit(1)
      .then(function (r) { return ((r.data && r.data[0] && r.data[0].numero_lancamento) || 0) + 1; });
  }

  function gravar(continuar) {
    var v;
    try {
      // buscas digitadas sem escolher na lista: confirma antes de validar
      return Promise.all($$('input.tt-input').map(function (i) { return i._confirmar ? i._confirmar() : null; }))
        .then(function () { calcularTotais(); v = validar(); return docId ? null : proximoLancamento(); })
        .then(function (numero) { return salvarDocumento(v, numero); })
        .then(function (id) {
          if (continuar) {
            docId = id;
            history.replaceState(null, '', '?id=' + id);
            E.aviso('Pedido salvo com sucesso.', 'success');
          } else {
            location.href = LISTA + '?salvo=1';
          }
        })
        .catch(function (e) { E.aviso(E.erroAmigavel(e)); });
    } catch (e) { E.aviso(E.erroAmigavel(e)); return Promise.resolve(); }
  }

  function salvarDocumento(v, numero) {
    var agora = E.agora();
    var prev = E.paraISO(campoDoc('data_previsao_entrega').value);
    if (prev === undefined) throw new Error('Data inválida em Previsão de Entrega.');
    var saida = campoDoc('data_hora_saida').value.trim(), saidaISO = null;
    if (saida) {
      var d = E.paraISO(saida.slice(0, 10));
      if (d === undefined) throw new Error('Data inválida em Data/Hora de Saída.');
      saidaISO = d + 'T' + (saida.slice(11, 16) || '00:00') + ':00';
    }
    var prazo = v.pagamentos.some(function (p) { return p.tipo === 'a_prazo'; });
    var cab = {
      empresa_id: E.EMPRESA_ID, filial_id: FILIAL_PADRAO, tipo_movimento: 'S', serie_documento: '1',
      operacao_documento_id: Number($('#operacao_documento_id').value),
      modelo_nf_id: Number($('#modelo_nf_id').value) || null,
      vendedor_id: Number($('#vendedor_id').value),
      pessoa_cliente_fornecedor_id: Number($('#pessoa_cliente_fornecedor_id').value) || null,
      endereco_cliente_fornecedor_id: Number(($('#endereco_cliente_fornecedor_id') || {}).value) || null,
      email_envio_nfe: campoDoc('email_envio_nfe').value || null,
      data_previsao_entrega: prev, data_hora_saida: saidaISO,
      tipo_pagamento: prazo ? 'a_prazo' : 'a_vista',
      valor_total_itens: round2(totais.itens), valor_descontos: round2(totais.descontos + totais.descontoDocumento),
      valor_frete: round2(totais.frete), valor_despesas_acessorias: round2(totais.despesas), valor_seguro: round2(totais.seguro),
      valor_total_documento: round2(totais.total), valor_total_pedido: round2(totais.total),
      observacoes: (campoDoc('observacoes') || {}).value || null,
      observacoes_internas: (campoDoc('observacoes_internas') || {}).value || null,
      updated_at: agora
    };
    if (!docId) {
      cab.numero_lancamento = numero;
      cab.data_lancamento_documento = agora;
      cab.data_emissao_documento = agora;
      cab.created_at = agora;
    }
    var q = docId ? sb.from('documentos').update(cab).eq('id', docId).select('id,numero_lancamento').single()
      : sb.from('documentos').insert(cab).select('id,numero_lancamento').single();
    var id, novo = !docId;
    return q.then(function (r) {
      if (r.error) throw r.error;
      id = r.data.id;
      $('#numero_lancamento').value = r.data.numero_lancamento || '';
      // na edição, itens e pagamentos são regravados por inteiro
      return novo ? null : Promise.all([
        sb.from('itens_documentos').delete().eq('documento_id', id),
        sb.from('pagamentos_documentos').delete().eq('documento_id', id)
      ]).then(function (rs) { rs.forEach(function (x) { if (x.error) throw x.error; }); });
    }).then(function () {
      var itens = v.itens.map(function (tr, i) {
        var qtd = num(campoLinha(tr, 'quantidade').value), unit = num(campoLinha(tr, 'valor_unitario').value);
        var desc = num(campoLinha(tr, 'valor_descontos').value), bruto = round2(qtd * unit), liquido = round2(bruto - desc);
        var prevItem = E.paraISO((campoLinha(tr, 'data_previsao_entrega') || {}).value);
        return {
          documento_id: id, empresa_id: E.EMPRESA_ID, filial_id: FILIAL_PADRAO, numero_item: i + 1,
          produto_id: Number(campoLinha(tr, 'produto_id').value),
          unidade_medida_id: Number((campoLinha(tr, 'unidade_medida_id') || {}).value) || null,
          tabela_preco_id: Number(campoLinha(tr, 'tabela_preco_id').value) || null,
          quantidade: qtd, quantidade_nota: qtd, valor_unitario: unit, valor_unitario_nota: unit, valor_tabela_preco: unit,
          valor_bruto: bruto, valor_descontos: desc, valor_liquido: liquido, valor_final: liquido,
          aliquota_pis: 0, aliquota_cofins: 0, valor_base_calculo_ipi: 0, valor_base_calculo_pis: 0, valor_base_calculo_cofins: 0,
          possui_entrega: !!(campoLinha(tr, 'possui_entrega') || {}).checked,
          possui_montagem: !!(campoLinha(tr, 'possui_montagem') || {}).checked,
          data_previsao_entrega: prevItem || null,
          created_at: agora, updated_at: agora
        };
      });
      return sb.from('itens_documentos').insert(itens);
    }).then(function (r) {
      if (r.error) throw r.error;
      var pags = v.pagamentos.map(function (p) {
        return Object.assign({ documento_id: id, created_at: agora, updated_at: agora }, p);
      });
      return pags.length ? sb.from('pagamentos_documentos').insert(pags) : { error: null };
    }).then(function (r) {
      if (r.error) throw r.error;
      return id;
    }).catch(function (e) {
      // pedido novo que falhou no meio: não deixa cabeçalho sem itens
      if (novo && id) {
        return sb.from('pagamentos_documentos').delete().eq('documento_id', id)
          .then(function () { return sb.from('itens_documentos').delete().eq('documento_id', id); })
          .then(function () { return sb.from('documentos').delete().eq('id', id); })
          .then(function () { $('#numero_lancamento').value = ''; throw e; });
      }
      throw e;
    });
  }
  function round2(v) { return Math.round((v || 0) * 100) / 100; }

  // ---------- abrir pedido salvo ----------
  function carregar(id) {
    return sb.from('documentos').select('*, itens:itens_documentos!itens_documentos_entradas_saidas_documento_id_fk(*, produto:produtos!itens_documentos_entradas_saidas_produto_id_fk(id,codigo,descricao)), pagamentos:pagamentos_documentos(*)')
      .eq('id', id).single().then(function (r) {
        if (r.error) throw r.error;
        var d = r.data;
        docId = d.id;
        $('#numero_lancamento').value = d.numero_lancamento || '';
        $('#operacao_documento_id').value = d.operacao_documento_id || '';
        if (d.modelo_nf_id) $('#modelo_nf_id').value = d.modelo_nf_id;
        $('#vendedor_id').value = d.vendedor_id || '';
        $('#pessoa_cliente_fornecedor_id').value = d.pessoa_cliente_fornecedor_id || '';
        campoDoc('email_envio_nfe').value = d.email_envio_nfe || '';
        campoDoc('data_previsao_entrega').value = E.dataBR(d.data_previsao_entrega);
        campoDoc('data_hora_saida').value = d.data_hora_saida ? E.dataHoraBR(d.data_hora_saida) : '';
        ['valor_frete', 'valor_despesas_acessorias', 'valor_seguro'].forEach(function (n) { campoDoc(n).value = moeda(d[n]); });
        if (campoDoc('observacoes')) campoDoc('observacoes').value = d.observacoes || '';
        if (campoDoc('observacoes_internas')) campoDoc('observacoes_internas').value = d.observacoes_internas || '';
        E.preencherBuscas();
        mostrarCliente(d.pessoa_cliente_fornecedor_id);
        var titulo = $('#barra_superior .titulo');
        if (titulo) titulo.lastChild.textContent = ' Pedido de Venda nº ' + (d.numero_lancamento || d.id);

        linhas().forEach(function (tr, i) { if (i) tr.remove(); });
        var itens = (d.itens || []).sort(function (a, b) { return a.numero_item - b.numero_item; });
        var passos = itens.map(function (it, i) {
          var tr = i === 0 ? linhas()[0] : novaLinha();
          return escolherProduto(tr, it.produto || { id: it.produto_id, codigo: '', descricao: '' }, it);
        });
        return Promise.all(passos).then(function () {
          novaLinha();
          // pagamentos agrupados por forma (agrupador)
          var grupos = {};
          (d.pagamentos || []).forEach(function (p) { (grupos[p.agrupador || p.forma_pagamento_id] = grupos[p.agrupador || p.forma_pagamento_id] || []).push(p); });
          pagamentoEditado = true;
          Object.keys(grupos).forEach(function (g, k) {
            var div = k === 0 ? linhasPag()[0] : novaLinhaPag();
            var ps = grupos[g].sort(function (a, b) { return a.parcela - b.parcela; });
            div.querySelector('select.forma-pagamento-id').value = ps[0].forma_pagamento_id;
            campoPag(div, 'valor').value = moeda(ps.reduce(function (s, p) { return s + Number(p.valor); }, 0));
            var qtd = div.querySelector('[atributo="parcelas"]'); if (qtd) qtd.value = ps.length;
            var primeiro = div.querySelector('[atributo="data_primeiro_vencimento"]'); if (primeiro) primeiro.value = E.dataBR(ps[0].data_vencimento);
            mostrarParcelamento(div);
            gerarParcelas(div, ps);
          });
          calcularTotais();
        });
      });
  }

  // ---------- botões do topo ----------
  function prepararTopo() {
    var novo = $('#botao_novo_documento');
    if (novo) novo.addEventListener('click', function () { location.href = location.pathname; });
    var docs = $('#botao_busca_documento');
    if (docs) docs.addEventListener('click', function () {
      var corpo = $('#container-documentos');
      corpo.innerHTML = '<tr><td colspan="4" class="text-center">Carregando...</td></tr>';
      sb.from('documentos').select('id,numero_lancamento,numero_documento,data_emissao_documento').eq('tipo_movimento', 'S')
        .order('id', { ascending: false }).limit(30).then(function (r) {
          if (r.error) { corpo.innerHTML = ''; E.aviso(E.erroAmigavel(r.error)); return; }
          corpo.innerHTML = r.data.length ? r.data.map(function (d) {
            return '<tr><td>' + E.esc(E.dataHoraBR(d.data_emissao_documento)) + '</td><td>' + E.esc(d.numero_lancamento) + '</td><td>' +
              E.esc(d.numero_documento || '') + '</td><td><a class="btn btn-primary btn-xs" href="?id=' + d.id + '">Abrir</a></td></tr>';
          }).join('') : '<tr><td colspan="4" class="text-center">Nenhum pedido salvo ainda.</td></tr>';
        });
      var modal = corpo.closest('.modal');
      if (modal && window.jQuery) window.jQuery(modal).modal('show');
    });
    // digitar o nº de lançamento e Enter abre o pedido
    var nl = $('#numero_lancamento');
    if (nl) nl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !nl.value.trim()) return;
      e.preventDefault();
      sb.from('documentos').select('id').eq('numero_lancamento', parseInt(nl.value, 10)).eq('tipo_movimento', 'S').limit(1).then(function (r) {
        if (!r.error && r.data.length) location.href = '?id=' + r.data[0].id;
        else E.aviso('Pedido nº ' + nl.value + ' não encontrado.', 'warning');
      });
    });
    var ver = $('#visualizar_venda');
    if (ver) ver.addEventListener('click', function (e) {
      e.preventDefault();
      E.aviso('Visualização/impressão da venda ainda não existe no protótipo.', 'info');
    });
  }

  function iniciar() {
    E = window.ERP; sb = E.sb;
    corpoItens = $('#container_linhas_tabela_produtos');
    containerPag = $('#copia_forma_pagamento');
    if (!corpoItens || !containerPag) return;

    trocarBootstrapSelect();
    prepararCelulas();
    E.prepararMascaras();
    E.prepararBuscas('documentos');

    // linha modelo: a primeira, limpa (as demais capturadas saem)
    linhas().forEach(function (tr, i) { if (i) tr.remove(); });
    var primeira = linhas()[0];
    $$('[name*="itens_documentos_locais_estocagens_attributes"]', primeira).forEach(function (el) { el.remove(); });
    modeloLinha = primeira.cloneNode(true);
    prepararLinha(primeira);
    limparLinha(primeira);
    var botao = $('#btn_adicionar_produto_na_lista');
    if (botao) botao.addEventListener('click', function () { var tr = novaLinha(); abrirCelula(tr.querySelector('td.coluna-descricao-produto')); });
    var lixeira = $('.remove-produto');
    if (lixeira) lixeira.addEventListener('click', function () {
      linhas().forEach(function (tr, i) { if (i) tr.remove(); else limparLinha(tr); });
      renumerar(); calcularTotais();
    });

    linhasPag().forEach(function (d, i) { if (i) d.remove(); });
    var pag = linhasPag()[0];
    var corpoParc = pag.querySelector('.conteiner-linhas-tabela-pagamentos');
    modeloParcela = corpoParc.querySelector('tr').cloneNode(true);
    modeloPag = pag.cloneNode(true);
    prepararLinhaPag(pag);

    prepararTotais();
    prepararTopo();
    var prev = campoDoc('data_previsao_entrega'); if (prev && !E.parametro('id')) prev.value = hojeBR(7);

    var cliente = $('#pessoa_cliente_fornecedor_id');
    if (cliente) observar(cliente, mostrarCliente);

    $$('.botao-salvar-venda').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); gravar(b.classList.contains('crud-btn-salvar-continuar')); });
    });
    $$('form').forEach(function (f) { f.addEventListener('submit', function (e) { e.preventDefault(); }); });

    carregarListas().then(function () {
      calcularTotais();
      var id = E.parametro('id');
      if (id) return carregar(id);
    }).catch(function (e) { E.aviso(E.erroAmigavel(e)); });
  }

  window.ERP_VENDA = { iniciar: iniciar };
})();
